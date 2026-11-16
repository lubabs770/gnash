// Reads default pref values from an install's omni.ja files (plain zips).
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { parsePrefs, type PrefValue } from "@gnash/prefs";

/** Returns the entries whose names pass `want`, decompressed, in central-directory order. */
export function readZip(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name) || (method !== 0 && method !== 8)) continue;
    const data = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(data, data + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
  }
  return out;
}

const isDefaultsFile = (n: string) =>
  n === "greprefs.js" || /^defaults\/(pref|preferences)\/[^/]+\.js$/.test(n);

const cache = new Map<string, { mtimeMs: number; prefs: Map<string, PrefValue> }>();

async function omniDefaults(file: string): Promise<Map<string, PrefValue>> {
  const { mtimeMs } = await stat(file);
  const hit = cache.get(file);
  if (hit?.mtimeMs === mtimeMs) return hit.prefs;
  const entries = readZip(await readFile(file), isDefaultsFile);
  // greprefs.js first, then the defaults folders, as Firefox loads them.
  const names = [...entries.keys()].sort((a, b) => Number(b === "greprefs.js") - Number(a === "greprefs.js"));
  const prefs = new Map<string, PrefValue>();
  for (const n of names) for (const p of parsePrefs(entries.get(n)!.toString("utf8"))) prefs.set(p.name, p.value);
  cache.set(file, { mtimeMs, prefs });
  return prefs;
}

/**
 * Defaults for an install: GRE omni.ja, then the app's (later wins).
 * Prefs compiled into the binary (StaticPrefList.yaml) are not in here.
 */
export async function loadDefaults(installDirs: string[]): Promise<{ prefs: Map<string, PrefValue>; missing: string[] }> {
  const prefs = new Map<string, PrefValue>();
  const missing: string[] = [];
  for (const dir of [...new Set(installDirs)]) {
    try {
      for (const [k, v] of await omniDefaults(join(dir, "omni.ja"))) prefs.set(k, v);
    } catch {
      missing.push(dir);
    }
  }
  return { prefs, missing };
}
