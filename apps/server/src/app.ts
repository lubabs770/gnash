// HTTP handler. Every request must pass the loopback Host check and carry the session cookie;
// state-changing requests must also come from our own Origin with a JSON body.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrefValue } from "@gnash/prefs";
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

type Row = { name: string; def?: PrefValue; prefs?: PrefValue; user?: PrefValue };

export function createApp(opts: AppOptions): Server {
  const getProfiles = opts.profiles ?? discoverProfiles;

  async function findProfile(id: string): Promise<Profile> {
    const p = (await getProfiles()).find((x) => x.id === id);
    if (!p) throw new HttpError(404, "profile not found");
    return p;
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const m = /^\/api\/profiles\/([0-9a-f]{12})(?:\/(preview|apply))?$/.exec(url.pathname);
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
      else {
        console.error(e);
        send(res, 500, { error: "internal error" });
      }
    }
  });
  return server;
}
