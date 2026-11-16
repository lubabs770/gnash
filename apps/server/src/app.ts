// HTTP handler. Every request must pass the loopback Host check and carry the session cookie;
// state-changing requests must also come from our own Origin with a JSON body.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrefValue } from "@gnash/prefs";
import CONTROLS from "../../../data/controls.json" with { type: "json" };
import { isFileKey, ProfileWatcher, readFiles, saveFile, type FileKey, type FileState } from "./files.ts";
import * as live from "./live.ts";
import { loadDefaults } from "./omni.ts";
import { discoverProfiles, isRunning, type Profile } from "./profiles.ts";
import { apply, ConflictError, preview, readLayers, validateChanges, ValidationError } from "./store.ts";

const COOKIE = "gnash_session";
const MAX_BODY = 2_000_000;
const INDEX_HTML = new URL("../../web/index.html", import.meta.url);

export interface AppOptions {
  token: string;
  /** Called on every authorized request; used for the idle shutdown. */
  onActivity?: () => void;
  profiles?: () => Promise<Profile[]>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "expected JSON");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "request too large");
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "invalid JSON");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function validateNames(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 5000 || !input.every((n) => typeof n === "string" && n.length <= 512)) {
    throw new ValidationError("names must be a list of pref names");
  }
  return input as string[];
}

type Row = { name: string; def?: PrefValue; prefs?: PrefValue; user?: PrefValue };

export function createApp(opts: AppOptions): Server {
  const getProfiles = opts.profiles ?? discoverProfiles;

  async function findProfile(id: string): Promise<Profile> {
    const p = (await getProfiles()).find((x) => x.id === id);
    if (!p) throw new HttpError(404, "profile not found");
    return p;
  }

  // Server-Sent Events: one profile watcher per profile while any tab listens.
  const listeners = new Map<string, { watcher: ProfileWatcher; clients: Set<ServerResponse> }>();
  /** Unsaved edits per profile+file, from the gnash editor or an agent; what "the current text" means. */
  const drafts = new Map<string, string>();
  /** Profile most recently opened in a gnash tab; agents default to it. */
  let focusProfile: string | null = null;

  function broadcast(profileId: string, event: string, data: unknown): void {
    for (const c of listeners.get(profileId)?.clients ?? []) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Push one file to live Firefox, if live is on for this profile. */
  async function syncLive(profileId: string, key: FileKey, text: string): Promise<live.SyncResult | { css: true } | null> {
    const s = liveSession(false);
    if (s?.profileId !== profileId) return null;
    if (key === "userJs") return s.syncUserJs(text);
    await s.syncCss(key === "userChrome" ? "chrome" : "content", text);
    return { css: true };
  }

  async function onDiskChange(p: Profile, key: FileKey, file: FileState): Promise<void> {
    let sync: unknown = null;
    try {
      sync = await syncLive(p.id, key, file.text);
    } catch (e) {
      sync = { error: e instanceof Error ? e.message : String(e) };
    }
    broadcast(p.id, "file-changed", { file: key, ...file, sync });
  }

  async function openEvents(req: IncomingMessage, res: ServerResponse, p: Profile): Promise<void> {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": connected\n\n");
    let entry = listeners.get(p.id);
    if (!entry) {
      const watcher = new ProfileWatcher(p.dir, (key, file) => void onDiskChange(p, key, file));
      entry = { watcher, clients: new Set() };
      listeners.set(p.id, entry);
      await watcher.start();
    }
    entry.clients.add(res);
    focusProfile = p.id;
    const beat = setInterval(() => (res.write(": beat\n\n"), opts.onActivity?.()), 25_000);
    req.on("close", () => {
      clearInterval(beat);
      entry.clients.delete(res);
      if (entry.clients.size === 0) {
        entry.watcher.close();
        listeners.delete(p.id);
      }
    });
  }

  function liveSession(required: boolean): live.LiveSession | null {
    const s = live.current;
    if (s?.isClosed) live.setCurrent(null);
    if (required && (!s || s.isClosed)) throw new HttpError(409, "Live mode is off");
    return s && !s.isClosed ? s : null;
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const m = /^\/api\/profiles\/([0-9a-f]{12})(?:\/(preview|apply|live|files|files\/save|events|draft))?$/.exec(url.pathname);
    const liveCmd = /^\/api\/live\/(read|set|revert|keep|stop|open)$/.exec(url.pathname)?.[1];
    if (req.method === "GET" && url.pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      const html = (await readFile(INDEX_HTML, "utf8")).replaceAll("<script>", `<script nonce="${nonce}">`);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(html);
    } else if (req.method === "GET" && url.pathname === "/api/ping") {
      send(res, 200, { ok: true });
    } else if (req.method === "GET" && url.pathname === "/api/controls") {
      send(res, 200, CONTROLS);
    } else if (req.method === "GET" && url.pathname === "/api/state") {
      const s = liveSession(false);
      const profiles = (await getProfiles()).map(({ id, name, isDefault, version }) => ({ id, name, isDefault, version }));
      send(res, 200, { profiles, focus: focusProfile, live: s ? { active: true, profileId: s.profileId } : { active: false } });
    } else if (req.method === "GET" && url.pathname === "/api/live") {
      const s = liveSession(false);
      send(res, 200, s ? { active: true, profileId: s.profileId, touched: [...s.originals.keys()] } : { active: false });
    } else if (req.method === "POST" && m?.[2] === "live") {
      await readJson(req);
      const p = await findProfile(m[1]!);
      const s = liveSession(false);
      if (s?.profileId !== p.id) {
        await live.stopCurrent();
        const started = await live.launchLive(p);
        live.setCurrent(started);
        // The copy applied user.js itself at startup; CSS comes only from gnash so edits fully replace it.
        const files = await readFiles(p.dir);
        started.primeUserJs(files.userJs.text);
        await started.syncCss("chrome", files.userChrome.text);
        await started.syncCss("content", files.userContent.text);
        // Unsaved drafts are what the user is looking at, so the copy shows those.
        for (const key of ["userJs", "userChrome", "userContent"] as const) {
          const d = drafts.get(`${p.id}:${key}`);
          if (d !== undefined) await syncLive(p.id, key, d);
        }
        broadcast(p.id, "live", { active: true });
      }
      send(res, 200, { active: true, profileId: p.id });
    } else if (req.method === "GET" && url.pathname === "/api/live/screenshot") {
      send(res, 200, { png: await liveSession(true)!.screenshot() });
    } else if (req.method === "GET" && m?.[2] === "events") {
      await openEvents(req, res, await findProfile(m[1]!));
    } else if (req.method === "GET" && m?.[2] === "files") {
      const p = await findProfile(m[1]!);
      const files = await readFiles(p.dir);
      const out: Record<string, FileState & { draft?: string }> = {};
      for (const [k, f] of Object.entries(files)) out[k] = { ...f, draft: drafts.get(`${p.id}:${k}`) };
      send(res, 200, out);
    } else if (req.method === "POST" && m?.[2] === "draft") {
      const body = await readJson(req);
      const p = await findProfile(m[1]!);
      if (!isFileKey(body.file) || typeof body.text !== "string" || body.text.length > 2_000_000) {
        throw new HttpError(400, "expected file and text");
      }
      const key = `${p.id}:${body.file}`;
      if (body.text === (await readFiles(p.dir))[body.file].text) drafts.delete(key);
      else drafts.set(key, body.text);
      let sync: unknown = null;
      try {
        sync = await syncLive(p.id, body.file, body.text);
      } catch (e) {
        if (!(e instanceof live.LiveError)) throw e;
        sync = { error: e.message };
      }
      const client = typeof body.client === "string" ? body.client.slice(0, 64) : "";
      broadcast(p.id, "draft", { file: body.file, text: body.text, client, sync });
      send(res, 200, { sync, unsaved: drafts.has(key) });
    } else if (req.method === "POST" && m?.[2] === "files/save") {
      const body = await readJson(req);
      const p = await findProfile(m[1]!);
      if (!isFileKey(body.file) || typeof body.text !== "string" || typeof body.hash !== "string" || body.text.length > 2_000_000) {
        throw new HttpError(400, "expected file, text and hash");
      }
      const saved = await saveFile(p.dir, body.file, body.text, body.hash);
      listeners.get(p.id)?.watcher.note(body.file, saved.hash);
      drafts.delete(`${p.id}:${body.file}`);
      broadcast(p.id, "saved", { file: body.file, text: body.text, hash: saved.hash });
      send(res, 200, saved);
    } else if (req.method === "POST" && liveCmd) {
      const body = await readJson(req);
      if (liveCmd === "stop") {
        const was = liveSession(false)?.profileId;
        await live.stopCurrent();
        if (was) broadcast(was, "live", { active: false });
        return send(res, 200, { active: false });
      }
      const s = liveSession(true)!;
      if (liveCmd === "open") {
        if (typeof body.url !== "string" || !/^(https?:\/\/|about:)/.test(body.url)) throw new HttpError(400, "url must be http(s) or about:");
        await s.navigate(body.url);
        send(res, 200, { ok: true });
      } else if (liveCmd === "set") {
        const [c] = validateChanges([{ name: body.name, value: body.value }]);
        await s.set(c!.name, c!.value);
        send(res, 200, { ok: true });
      } else {
        const names = body.names === undefined && liveCmd === "revert" ? undefined : validateNames(body.names);
        if (liveCmd === "read") send(res, 200, await s.read(names!));
        else if (liveCmd === "keep") (s.keep(names!), send(res, 200, { ok: true }));
        else (await s.revert(names), send(res, 200, { ok: true }));
      }
    } else if (req.method === "GET" && url.pathname === "/api/profiles") {
      const list = await getProfiles();
      send(
        res,
        200,
        list.map(({ id, browser, name, isDefault, version }) => ({ id, browser, name, isDefault, version })),
      );
    } else if (req.method === "GET" && m && !m[2]) {
      const p = await findProfile(m[1]!);
      const [{ prefs: defaults, missing }, layers, running] = await Promise.all([
        loadDefaults(p.installDirs),
        readLayers(p.dir),
        isRunning(p).catch(() => null),
      ]);
      const names = new Set([...defaults.keys(), ...layers.prefsJs.keys(), ...layers.userJs.keys()]);
      const rows: Row[] = [...names].sort().map((name) => ({
        name,
        def: defaults.get(name),
        prefs: layers.prefsJs.get(name),
        user: layers.userJs.get(name),
      }));
      send(res, 200, {
        running,
        defaultsFound: missing.length === 0 && p.installDirs.length > 0,
        userJsHash: layers.userJsHash,
        rows,
      });
    } else if (req.method === "POST" && m?.[2] === "preview") {
      const body = await readJson(req);
      const p = await findProfile(m[1]!);
      send(res, 200, await preview(p.dir, validateChanges(body.changes)));
    } else if (req.method === "POST" && m?.[2] === "apply") {
      const body = await readJson(req);
      const p = await findProfile(m[1]!);
      if (typeof body.hash !== "string") throw new HttpError(400, "missing hash");
      send(res, 200, { backup: await apply(p.dir, validateChanges(body.changes), body.hash) });
    } else {
      throw new HttpError(404, "not found");
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const port = (server.address() as AddressInfo).port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      // DNS rebinding: a hostile site resolving its name to 127.0.0.1 still sends its own Host.
      if (!allowedHosts.includes(req.headers.host ?? "")) throw new HttpError(403, "bad host");
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      // First visit: trade the one-time link token for an HttpOnly cookie, then drop it from the URL.
      const given = url.searchParams.get("token");
      if (req.method === "GET" && url.pathname === "/" && given !== null) {
        if (!safeEqual(given, opts.token)) throw new HttpError(403, "bad token");
        res.writeHead(302, {
          "set-cookie": `${COOKIE}=${opts.token}; HttpOnly; SameSite=Strict; Path=/`,
          location: "/",
          "referrer-policy": "no-referrer",
        });
        return void res.end();
      }
      if (!safeEqual(cookie(req, COOKIE) ?? "", opts.token)) {
        throw new HttpError(401, "Open gnash with the link it printed in your terminal.");
      }
      if (req.method !== "GET" && !allowedHosts.some((h) => req.headers.origin === `http://${h}`)) {
        throw new HttpError(403, "bad origin");
      }
      opts.onActivity?.();
      await route(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message });
      else if (e instanceof ConflictError) send(res, 409, { error: e.message });
      else if (e instanceof ValidationError) send(res, 400, { error: e.message });
      else if (e instanceof live.LiveError) send(res, 502, { error: e.message });
      else if (e instanceof live.LiveClosedError) {
        live.setCurrent(null);
        send(res, 410, { error: "Firefox was closed, so live mode ended." });
      }
      else {
        console.error(e);
        send(res, 500, { error: "internal error" });
      }
    }
  });
  return server;
}
