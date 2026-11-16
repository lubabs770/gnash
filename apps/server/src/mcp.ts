// MCP server (stdio) so an agent can drive gnash: edit user.js / userChrome.css / userContent.css,
// watch them apply in the live Firefox copy, and look at the result.
// Register with:  claude mcp add gnash -- node /path/to/gnash/apps/server/src/mcp.ts
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SESSION_FILE, type Session } from "./session.ts";

const FILE_KEYS = { "user.js": "userJs", "userChrome.css": "userChrome", "userContent.css": "userContent" } as const;
type FileName = keyof typeof FILE_KEYS;
type Api = (path: string, body?: unknown) => Promise<any>;
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const INSTRUCTIONS = `gnash edits a Firefox profile's user.js, userChrome.css and userContent.css, and can show every change live in a second Firefox window running a copy of the profile.
Workflow: call status, then live {on:true} if live is off. read_file before changing a file. write_file or edit_file put your change in the gnash editor as an unsaved draft and apply it live immediately; check the result with screenshot. The user saves with Cmd-S in gnash; only call save_file when they ask you to save.
user.js lines look like user_pref("name", value); use search_prefs to find real pref names and defaults. userChrome.css styles Firefox's own UI (e.g. #nav-bar, #TabsToolbar, #urlbar, .tabbrowser-tab, #sidebar-main); use !important. userContent.css styles web pages; use open_page to load a site in the live copy to check it.`;

const fileArg = { type: "string", enum: Object.keys(FILE_KEYS), description: "Which file" };
const profileArg = { type: "string", description: "Profile name; defaults to the one open in gnash or live" };

export const TOOLS = [
  { name: "status", description: "Profiles, which one gnash is showing, and whether the live Firefox copy is running.", inputSchema: { type: "object", properties: {} } },
  { name: "read_file", description: "Current text of a file: the unsaved draft if there is one, else what's on disk.", inputSchema: { type: "object", properties: { file: fileArg, profile: profileArg }, required: ["file"] } },
  { name: "write_file", description: "Replace a file's whole text. Becomes an unsaved draft in the gnash editor and applies live at once. Returns what Firefox accepted (prefs applied, unknown prefs, errors).", inputSchema: { type: "object", properties: { file: fileArg, content: { type: "string" }, profile: profileArg }, required: ["file", "content"] } },
  { name: "edit_file", description: "Replace one exact occurrence of old_string with new_string in a file (draft + live, like write_file).", inputSchema: { type: "object", properties: { file: fileArg, old_string: { type: "string" }, new_string: { type: "string" }, profile: profileArg }, required: ["file", "old_string", "new_string"] } },
  { name: "save_file", description: "Write the draft to the real profile (with a backup). Only when the user asks to save.", inputSchema: { type: "object", properties: { file: fileArg, profile: profileArg }, required: ["file"] } },
  { name: "search_prefs", description: "Find prefs by name (space-separated words must all match). Shows default, prefs.js and user.js values.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, profile: profileArg }, required: ["query"] } },
  { name: "live", description: "Open (on: true) or close (on: false) the live Firefox copy of the profile.", inputSchema: { type: "object", properties: { on: { type: "boolean" }, profile: profileArg }, required: ["on"] } },
  { name: "open_page", description: "Load a URL in the live copy's current tab, e.g. to check userContent.css on a real site.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "screenshot", description: "Picture of the live Firefox copy's window, so you can see what your changes did.", inputSchema: { type: "object", properties: {} } },
];

const fmt = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v));
const text = (t: string): Content[] => [{ type: "text", text: t }];

function describeSync(sync: any): string {
  if (!sync) return "Live is off, so nothing was applied in Firefox. Use live {on:true} to see changes.";
  if (sync.error) return `Firefox refused it: ${sync.error}`;
  if (sync.css) return "CSS applied live.";
  const parts = [`${sync.applied} prefs in file, ${sync.changed} changed live.`];
  if (sync.unknown?.length) parts.push(`Unknown to Firefox (typo or removed pref?): ${sync.unknown.join(", ")}.`);
  for (const e of sync.errors ?? []) parts.push(e.line ? `Line ${e.line}: ${e.message}.` : `${e.name}: ${e.message}.`);
  return parts.join(" ");
}

/** Tool implementations over the gnash HTTP API. */
export function createTools(api: Api) {
  async function profileId(name?: unknown): Promise<string> {
    const st = await api("/api/state");
    if (typeof name === "string" && name) {
      const p = st.profiles.find((x: any) => x.name.toLowerCase() === name.toLowerCase());
      if (!p) throw new Error(`No profile named ${name}. Profiles: ${st.profiles.map((x: any) => x.name).join(", ")}`);
      return p.id;
    }
    const id = (st.live.active && st.live.profileId) || st.focus || st.profiles.find((x: any) => x.isDefault)?.id || st.profiles[0]?.id;
    if (!id) throw new Error("No Firefox profiles found");
    return id;
  }

  function fileKey(f: unknown) {
    if (typeof f !== "string" || !(f in FILE_KEYS)) throw new Error(`file must be one of ${Object.keys(FILE_KEYS).join(", ")}`);
    return FILE_KEYS[f as FileName];
  }

  async function current(id: string, key: string) {
    const f = (await api(`/api/profiles/${id}/files`))[key];
    return { text: (f.draft ?? f.text) as string, disk: f.text as string, hash: f.hash as string, unsaved: f.draft !== undefined };
  }

  async function draft(id: string, key: string, t: string): Promise<Content[]> {
    const r = await api(`/api/profiles/${id}/draft`, { file: key, text: t, client: "agent" });
    return text(`${describeSync(r.sync)}${r.unsaved ? " Unsaved draft; the user saves with Cmd-S in gnash." : " Matches the saved file."}`);
  }

  return {
    async status(): Promise<Content[]> {
      const st = await api("/api/state");
      const lines = st.profiles.map((p: any) => `- ${p.name}${p.isDefault ? " (default)" : ""}${p.id === st.focus ? " ← open in gnash" : ""}${st.live.profileId === p.id ? " ← live" : ""}`);
      return text(`Profiles:\n${lines.join("\n")}\nLive copy: ${st.live.active ? "running" : "off"}`);
    },
    async read_file(a: any) {
      const c = await current(await profileId(a.profile), fileKey(a.file));
      return text(`${a.file} (${c.unsaved ? "unsaved draft" : "saved"}):\n${c.text || "(empty)"}`);
    },
    async write_file(a: any) {
      if (typeof a.content !== "string") throw new Error("content must be text");
      return draft(await profileId(a.profile), fileKey(a.file), a.content);
    },
    async edit_file(a: any) {
      const id = await profileId(a.profile);
      const key = fileKey(a.file);
      const c = await current(id, key);
      const n = c.text.split(a.old_string).length - 1;
      if (!a.old_string || n !== 1) throw new Error(`old_string must occur exactly once in ${a.file}; found ${n}`);
      return draft(id, key, c.text.replace(a.old_string, () => a.new_string));
    },
    async save_file(a: any) {
      const id = await profileId(a.profile);
      const key = fileKey(a.file);
      const c = await current(id, key);
      if (!c.unsaved) return text(`${a.file} has no unsaved changes.`);
      const r = await api(`/api/profiles/${id}/files/save`, { file: key, text: c.text, hash: c.hash });
      return text(`Saved ${a.file}. Backup: .gnash-backups/${r.backup}`);
    },
    async search_prefs(a: any) {
      const words = String(a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const limit = Math.min(Math.max(Number(a.limit) || 30, 1), 200);
      const { rows } = await api(`/api/profiles/${await profileId(a.profile)}`);
      const hits = rows.filter((r: any) => words.every((w) => r.name.toLowerCase().includes(w)));
      const out = hits.slice(0, limit).map((r: any) => `${r.name}  default=${fmt(r.def)}  prefs.js=${fmt(r.prefs)}  user.js=${fmt(r.user)}`);
      return text(`${hits.length} match${hits.length === 1 ? "" : "es"}${hits.length > limit ? `, showing ${limit}` : ""}:\n${out.join("\n")}`);
    },
    async live(a: any) {
      if (a.on === false) {
        await api("/api/live/stop", {});
        return text("Live copy closed.");
      }
      await api(`/api/profiles/${await profileId(a.profile)}/live`, {});
      return text("Live copy is running. Edits now apply as you make them; use screenshot to look.");
    },
    async open_page(a: any) {
      await api("/api/live/open", { url: a.url });
      return text(`Opened ${a.url} in the live copy.`);
    },
    async screenshot(): Promise<Content[]> {
      await new Promise((r) => setTimeout(r, 150)); // let Firefox repaint after the last change
      const { png } = await api("/api/live/screenshot");
      return [{ type: "image", data: png, mimeType: "image/png" }];
    },
  } as Record<string, (a: any) => Promise<Content[]>>;
}

/** JSON-RPC handler; returns the response object, or undefined for notifications. */
export function createHandler(api: Api) {
  const tools = createTools(api);
  return async (msg: any): Promise<object | undefined> => {
    const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "gnash", version: "0.1.0" },
          instructions: INSTRUCTIONS,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const fn = tools[msg.params?.name];
        if (!fn) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool ${msg.params?.name}` } };
        try {
          return reply({ content: await fn(msg.params?.arguments ?? {}) });
        } catch (e) {
          return reply({ content: text(e instanceof Error ? e.message : String(e)), isError: true });
        }
      }
      default:
        if (msg.id === undefined) return undefined; // notifications (initialized, cancelled, …)
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  };
}

// --- connecting to (or starting) gnash -------------------------------------

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readSession(): Promise<Session | null> {
  try {
    const s = JSON.parse(await readFile(SESSION_FILE, "utf8")) as Session;
    return alive(s.pid) ? s : null;
  } catch {
    return null;
  }
}

let starting: Promise<Session> | null = null;

/** The running gnash, starting one (which opens its UI in the browser) if needed. */
async function connect(): Promise<Session> {
  const s = await readSession();
  if (s) return s;
  starting ??= (async () => {
    const main = fileURLToPath(new URL("./main.ts", import.meta.url));
    spawn(process.execPath, [main], { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const s2 = await readSession();
      if (s2) return s2;
    }
    throw new Error("Couldn't start gnash");
  })().finally(() => (starting = null));
  return starting;
}

async function api(path: string, body?: unknown): Promise<any> {
  const s = await connect();
  const origin = `http://127.0.0.1:${s.port}`;
  const res = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: `gnash_session=${s.token}`, origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `gnash answered ${res.status}`);
  return json;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const handle = createHandler(api);
  const out = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    void handle(msg).then((r) => r && out(r));
  });
}
