// Live mode: drive a scratch copy of the profile in a real Firefox through Marionette
// (its remote-control protocol), so prefs and CSS changes show up immediately.
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parsePrefs, toMap, type PrefValue } from "@gnash/prefs";
import type { Profile } from "./profiles.ts";

export class LiveClosedError extends Error {}
/** Firefox refused a command, or could not be started; the message is safe to show. */
export class LiveError extends Error {}

/** Marionette wire protocol: packets are `<byte length>:<json>`; commands `[0,id,name,params]`, replies `[1,id,error,result]`. */
export class Marionette {
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private greeted: Promise<unknown>;
  private closed = false;
  private readonly sock: Socket;

  private constructor(sock: Socket) {
    this.sock = sock;
    let greet!: (v: unknown) => void;
    this.greeted = new Promise((r) => (greet = r));
    sock.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const colon = this.buf.indexOf(0x3a);
        if (colon < 0) break;
        const len = Number(this.buf.toString("ascii", 0, colon));
        if (this.buf.length < colon + 1 + len) break;
        const msg: unknown = JSON.parse(this.buf.toString("utf8", colon + 1, colon + 1 + len));
        this.buf = this.buf.subarray(colon + 1 + len);
        if (!Array.isArray(msg)) greet(msg);
        else {
          const [, id, error, result] = msg as [number, number, { error: string; message: string } | null, unknown];
          const w = this.waiting.get(id);
          this.waiting.delete(id);
          if (error) w?.reject(new LiveError(`${error.error}: ${error.message}`));
          else w?.resolve(result);
        }
      }
    });
    const fail = () => {
      this.closed = true;
      for (const w of this.waiting.values()) w.reject(new LiveClosedError("Firefox closed the live connection"));
      this.waiting.clear();
    };
    sock.on("close", fail).on("error", fail);
  }

  static async connect(port: number, host = "127.0.0.1"): Promise<Marionette> {
    const sock = await new Promise<Socket>((ok, bad) => {
      const s = connect(port, host, () => ok(s)).once("error", bad);
    });
    const m = new Marionette(sock);
    // Marionette serves one client at a time; another client holding it means no greeting ever comes.
    const timeout = sleep(5000).then(() => {
      throw new Error("Firefox accepted the connection but never greeted");
    });
    try {
      await Promise.race([m.greeted, timeout]);
    } catch (e) {
      m.close();
      throw e;
    }
    return m;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  command(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new LiveClosedError("Firefox closed the live connection"));
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify([0, id, name, params]));
    this.sock.write(Buffer.concat([Buffer.from(`${body.length}:`), body]));
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }

  close(): void {
    this.sock.destroy();
  }
}

// Runs in Firefox's chrome context, where `Services` exists.
const READ_SCRIPT = `
const P = Services.prefs, D = P.getDefaultBranch("");
const read = (b, n) => { try { switch (b.getPrefType(n)) {
  case b.PREF_BOOL: return b.getBoolPref(n);
  case b.PREF_INT: return b.getIntPref(n);
  case b.PREF_STRING: return b.getStringPref(n);
} } catch (e) {} return null; };
return arguments[0].map((n) => ({ name: n, value: read(P, n), def: read(D, n), hasUser: P.prefHasUserValue(n) }));`;

const SET_SCRIPT = `
const [n, v] = arguments, P = Services.prefs;
if (v === null) P.clearUserPref(n);
else if (typeof v === "boolean") P.setBoolPref(n, v);
else if (typeof v === "number") P.setIntPref(n, v);
else P.setStringPref(n, v);
return true;`;

// Swaps gnash's userChrome sheet in every browser window, and in windows opened later.
// State lives on the hidden window so it outlives this script's sandbox.
const CHROME_CSS_SCRIPT = `
const [uri] = arguments, G = Services.appShell.hiddenDOMWindow;
const st = G.__gnash || (G.__gnash = { chrome: null, content: null, listener: null });
const swap = (w) => { const u = w.windowUtils;
  if (st.chrome) try { u.removeSheetUsingURIString(st.chrome, u.USER_SHEET); } catch (e) {}
  if (uri) u.loadSheetUsingURIString(uri, u.USER_SHEET); };
for (const w of Services.wm.getEnumerator("navigator:browser")) swap(w);
st.chrome = uri;
if (!st.listener) {
  st.listener = { onOpenWindow(x) { const w = x.docShell.domWindow;
    w.addEventListener("load", () => { if (st.chrome) w.windowUtils.loadSheetUsingURIString(st.chrome, w.windowUtils.USER_SHEET); }, { once: true }); },
    onCloseWindow() {} };
  Services.wm.addListener(st.listener);
}
return true;`;

// Swaps gnash's userContent sheet in the global style sheet service (reaches web pages).
const CONTENT_CSS_SCRIPT = `
const [uri] = arguments, G = Services.appShell.hiddenDOMWindow;
const st = G.__gnash || (G.__gnash = { chrome: null, content: null, listener: null });
const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
if (st.content) { const old = Services.io.newURI(st.content); if (sss.sheetRegistered(old, sss.USER_SHEET)) sss.unregisterSheet(old, sss.USER_SHEET); }
if (uri) sss.loadAndRegisterSheet(Services.io.newURI(uri), sss.USER_SHEET);
st.content = uri;
return true;`;

export type LiveValue = { name: string; value: PrefValue | null; def: PrefValue | null; hasUser: boolean };
export type SyncResult = {
  applied: number;
  changed: number;
  unknown: string[];
  /** 1-based lines that mention user_pref but didn't parse, or prefs Firefox refused */
  errors: { line?: number; name?: string; message: string }[];
};

export class LiveSession {
  /** User value each touched pref had before gnash changed it; null = it had none. */
  readonly originals = new Map<string, PrefValue | null>();
  readonly profileId: string;
  /** The scratch copy Firefox runs on; CSS versions are written into its chrome/ folder. */
  readonly scratchDir: string;
  private readonly m: Marionette;
  private synced = new Map<string, PrefValue>();
  private cssFiles: Partial<Record<CssKind, string>> = {};
  private cssVersion = 0;

  constructor(profileId: string, m: Marionette, scratchDir = "") {
    this.profileId = profileId;
    this.m = m;
    this.scratchDir = scratchDir;
  }

  static async open(profileId: string, m: Marionette, scratchDir = ""): Promise<LiveSession> {
    try {
      await m.command("WebDriver:NewSession", { capabilities: {} });
      await m.command("Marionette:SetContext", { value: "chrome" });
    } catch (e) {
      m.close(); // free Firefox's single Marionette slot
      throw e;
    }
    return new LiveSession(profileId, m, scratchDir);
  }

  get isClosed(): boolean {
    return this.m.isClosed;
  }

  private async exec(script: string, args: unknown[]): Promise<unknown> {
    const r = (await this.m.command("WebDriver:ExecuteScript", { script, args })) as { value: unknown };
    return r.value;
  }

  read(names: string[]): Promise<LiveValue[]> {
    return this.exec(READ_SCRIPT, [names]) as Promise<LiveValue[]>;
  }

  async set(name: string, value: PrefValue | null): Promise<void> {
    if (!this.originals.has(name)) {
      const [cur] = await this.read([name]);
      this.originals.set(name, cur?.hasUser ? cur.value : null);
    }
    await this.exec(SET_SCRIPT, [name, value]);
  }

  /** Put touched prefs (all, or just `names`) back how they were. */
  async revert(names = [...this.originals.keys()]): Promise<void> {
    for (const n of names) {
      if (!this.originals.has(n)) continue;
      await this.exec(SET_SCRIPT, [n, this.originals.get(n)]);
      this.originals.delete(n);
    }
  }

  /** Stop tracking prefs the user saved to user.js, so they're not reverted. */
  keep(names: string[]): void {
    for (const n of names) this.originals.delete(n);
  }

  /** What Firefox already applied from user.js at startup; later syncs diff against it. */
  primeUserJs(text: string): void {
    this.synced = toMap(parsePrefs(text));
  }

  /** Make live Firefox match a user.js text: set what changed, clear what was removed. */
  async syncUserJs(text: string): Promise<SyncResult> {
    const desired = toMap(parsePrefs(text));
    const errors: SyncResult["errors"] = unparsedLines(text).map((line) => ({ line, message: "didn't parse" }));
    const names = [...new Set([...desired.keys(), ...this.synced.keys()])];
    const current = new Map((await this.read(names)).map((v) => [v.name, v]));
    const unknown: string[] = [];
    let changed = 0;
    for (const [name, value] of desired) {
      const cur = current.get(name);
      if (cur && cur.value === null && cur.def === null) unknown.push(name);
      if (cur?.value === value) continue;
      try {
        await this.set(name, value);
        changed++;
      } catch (e) {
        if (!(e instanceof LiveError)) throw e;
        const existing = cur?.def ?? cur?.value;
        // Firefox reports a type clash as NS_ERROR_UNEXPECTED; say what it expects instead.
        const message = /NS_ERROR_UNEXPECTED/.test(e.message) && existing != null
          ? `Firefox expects ${typeof existing === "number" ? "an integer" : typeof existing === "boolean" ? "true or false" : "a string"}`
          : e.message.replace(/^[^:]*: /, "");
        errors.push({ name, message });
      }
    }
    for (const name of this.synced.keys()) {
      if (desired.has(name)) continue;
      await this.set(name, null); // removed from user.js: back to the default
      changed++;
    }
    this.synced = desired;
    return { applied: desired.size, changed, unknown, errors };
  }

  /**
   * Replace the live userChrome ("chrome") or userContent ("content") sheet. The CSS is written as a
   * real file inside the copy's chrome/ folder, so relative @imports resolve like they do for Firefox.
   */
  async syncCss(kind: CssKind, css: string): Promise<void> {
    let uri: string | null = null;
    const prev = this.cssFiles[kind];
    if (css.trim()) {
      const file = join(this.scratchDir, "chrome", `.gnash-${kind}-${++this.cssVersion}.css`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, css);
      this.cssFiles[kind] = file;
      uri = pathToFileURL(file).href;
    } else delete this.cssFiles[kind];
    await this.exec(kind === "chrome" ? CHROME_CSS_SCRIPT : CONTENT_CSS_SCRIPT, [uri]);
    if (prev) await rm(prev, { force: true });
  }

  /** PNG (base64) of the front browser window, chrome included. */
  async screenshot(): Promise<string> {
    const r = (await this.m.command("WebDriver:TakeScreenshot", { full: false })) as { value: string };
    return r.value;
  }

  /** Quit the scratch Firefox and delete its copy of the profile. */
  async stop(): Promise<void> {
    try {
      await Promise.race([this.m.command("Marionette:Quit", { flags: ["eForceQuit"] }), sleep(3000)]);
    } catch {
      // Firefox closing the socket while quitting is the expected outcome
    } finally {
      this.m.close();
    }
    if (this.scratchDir) {
      await sleep(500); // let Firefox finish exiting before its files go
      await rm(this.scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }
}

export type CssKind = "chrome" | "content";

/** 1-based numbers of uncommented lines that mention user_pref( but held no parsed statement. */
export function unparsedLines(text: string): number[] {
  const starts = new Set<number>();
  for (const p of parsePrefs(text)) starts.add(text.slice(0, p.start).split("\n").length);
  const out: number[] = [];
  text.split("\n").forEach((l, i) => {
    const t = l.trim();
    if (/\buser_pref\s*\(/.test(t) && !/^(\/\/|#|\/?\*)/.test(t) && !starts.has(i + 1)) out.push(i + 1);
  });
  return out;
}

/** Firefox binary for a profile's install. */
export function firefoxBinary(p: Profile): string | undefined {
  const dir = p.installDirs[0];
  if (!dir) return undefined;
  if (process.platform === "darwin") return resolve(dir, "../MacOS/firefox");
  return join(dir, process.platform === "win32" ? "firefox.exe" : "firefox");
}

const COPY = ["prefs.js", "user.js", "xulstore.json", "containers.json", "extensions.json", "extensions", "chrome"];

/**
 * Fresh scratch copy of the profile's look-and-feel: prefs, toolbar layout, extensions, chrome/ assets.
 * userChrome.css/userContent.css are left out; gnash injects them, so edits fully replace them.
 */
export async function makeScratchProfile(p: Profile): Promise<string> {
  const scratch = join(tmpdir(), `gnash-live-${p.id}`);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  for (const name of COPY) {
    await cp(join(p.dir, name), join(scratch, name), {
      recursive: true,
      filter: (src) => !/[\\/]chrome[\\/](userChrome|userContent)\.css$/.test(src),
    }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  return scratch;
}

/** Launch Firefox on a scratch copy of this profile with Marionette on, then connect. */
export async function launchLive(p: Profile, timeoutMs = 45_000): Promise<LiveSession> {
  const bin = firefoxBinary(p);
  if (!bin) throw new LiveError("Couldn't find this profile's Firefox install");
  const scratch = await makeScratchProfile(p);
  const started = Date.now();
  // --no-remote: always a separate instance, even with your everyday Firefox open.
  // MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: Firefox 160 refuses chrome-context scripts (needed for Services.prefs) without it.
  spawn(bin, ["--marionette", "--no-remote", "--profile", scratch], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
  }).unref();

  const portFile = join(scratch, "MarionetteActivePort");
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    await sleep(500);
    let m: Marionette;
    try {
      m = await Marionette.connect(Number((await readFile(portFile, "utf8")).trim()));
    } catch (e) {
      lastError = e; // not up yet: retry
      continue;
    }
    return LiveSession.open(p.id, m, scratch); // Firefox answered; its refusals are final, not retried
  }
  throw new LiveError(`Firefox didn't start remote control in time${lastError ? ` (${String(lastError)})` : ""}`);
}

/** The one live session gnash runs at a time. */
export let current: LiveSession | null = null;

export function setCurrent(s: LiveSession | null): void {
  current = s;
}

export async function stopCurrent(): Promise<void> {
  const s = current;
  current = null;
  if (s && !s.isClosed) await s.stop().catch(() => {});
}
