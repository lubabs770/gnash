// Live mode: drive a real Firefox through Marionette (its remote-control protocol)
// so pref changes show up immediately. Firefox must be started with --marionette.
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { PrefValue } from "@gnash/prefs";
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

export type LiveValue = { name: string; value: PrefValue | null; def: PrefValue | null; hasUser: boolean };

export class LiveSession {
  /** User value each touched pref had before gnash changed it; null = it had none. */
  readonly originals = new Map<string, PrefValue | null>();

  readonly profileId: string;
  private readonly m: Marionette;

  constructor(profileId: string, m: Marionette) {
    this.profileId = profileId;
    this.m = m;
  }

  static async open(profileId: string, m: Marionette): Promise<LiveSession> {
    try {
      await m.command("WebDriver:NewSession", { capabilities: {} });
      await m.command("Marionette:SetContext", { value: "chrome" });
    } catch (e) {
      m.close(); // free Firefox's single Marionette slot
      throw e;
    }
    return new LiveSession(profileId, m);
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

  async stop(): Promise<void> {
    try {
      await this.revert();
      await this.m.command("WebDriver:DeleteSession");
    } finally {
      this.m.close();
    }
  }
}

/** Firefox binary for a profile's install. */
export function firefoxBinary(p: Profile): string | undefined {
  const dir = p.installDirs[0];
  if (!dir) return undefined;
  if (process.platform === "darwin") return resolve(dir, "../MacOS/firefox");
  return join(dir, process.platform === "win32" ? "firefox.exe" : "firefox");
}

/** Launch Firefox on this profile with Marionette on, then connect. */
export async function launchLive(p: Profile, timeoutMs = 45_000): Promise<LiveSession> {
  const bin = firefoxBinary(p);
  if (!bin) throw new LiveError("Couldn't find this profile's Firefox install");
  const portFile = join(p.dir, "MarionetteActivePort");
  const started = Date.now();
  // --no-remote: never hand off to another running Firefox; this must be a fresh instance.
  // MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: Firefox 160 refuses chrome-context scripts (needed for Services.prefs) without it.
  spawn(bin, ["--marionette", "--no-remote", "--profile", p.dir], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
  }).unref();

  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    await sleep(500);
    let m: Marionette;
    try {
      // Firefox writes this file once Marionette listens; ignore one left over from an earlier run.
      if ((await stat(portFile)).mtimeMs < started - 1000) continue;
      m = await Marionette.connect(Number((await readFile(portFile, "utf8")).trim()));
    } catch (e) {
      lastError = e; // not up yet: retry
      continue;
    }
    return LiveSession.open(p.id, m); // Firefox answered; its refusals are final, not retried
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
