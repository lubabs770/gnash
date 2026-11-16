// Reads a profile's three pref layers and writes user.js changes: diff, backup, atomic write.
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PrefsFile, toMap, parsePrefs, type PrefValue } from "@gnash/prefs";
import { unifiedDiff } from "./diff.ts";

export const BACKUP_DIR = ".gnash-backups";
const KEEP_BACKUPS = 20;

export type Change = { name: string; value: PrefValue | null };

export class ConflictError extends Error {}
export class ValidationError extends Error {}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

async function readOptional(p: string): Promise<string> {
  try {
    return await readFile(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

export async function readLayers(dir: string) {
  const userJs = await readOptional(join(dir, "user.js"));
  const prefsJs = await readOptional(join(dir, "prefs.js"));
  return {
    userJs: toMap(parsePrefs(userJs)),
    prefsJs: toMap(parsePrefs(prefsJs)),
    userJsHash: hash(userJs),
  };
}

/** Validates changes from the client; throws a message safe to show. */
export function validateChanges(input: unknown): Change[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 5000) throw new ValidationError("changes must be a non-empty list");
  return input.map((c: unknown) => {
    const { name, value } = (c ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !/^[^\0-\x1f\x7f]{1,512}$/.test(name)) throw new ValidationError("invalid pref name");
    const ok =
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "string" && value.length <= 1_000_000) ||
      (typeof value === "number" && Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31);
    if (!ok) throw new ValidationError(`invalid value for ${name}`);
    return { name, value: value as PrefValue | null };
  });
}

function applyTo(text: string, changes: Change[]): string {
  const f = new PrefsFile(text);
  for (const c of changes) c.value === null ? f.remove(c.name) : f.set(c.name, c.value);
  return f.toString();
}

export async function preview(dir: string, changes: Change[]) {
  const before = await readOptional(join(dir, "user.js"));
  return { diff: unifiedDiff(before, applyTo(before, changes), "user.js"), hash: hash(before) };
}

/**
 * Applies changes to user.js if it still matches `expectedHash` (what the user reviewed).
 * Backs up user.js and prefs.js first, then writes atomically. Returns the backup folder name.
 */
export async function apply(dir: string, changes: Change[], expectedHash: string): Promise<string> {
  const userJs = join(dir, "user.js");
  const before = await readOptional(userJs);
  if (hash(before) !== expectedHash) throw new ConflictError("user.js changed since the preview; review again");
  const after = applyTo(before, changes);

  const name = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(dir, BACKUP_DIR, name);
  await mkdir(backup, { recursive: true });
  for (const f of ["user.js", "prefs.js"]) {
    try {
      await copyFile(join(dir, f), join(backup, f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  await pruneBackups(join(dir, BACKUP_DIR));

  // Write through symlinks (user.js is often linked from a dotfiles repo) so the link survives.
  let target = userJs;
  try {
    target = await realpath(userJs);
  } catch {}
  await atomicWrite(target, after);
  return name;
}

async function atomicWrite(file: string, text: string): Promise<void> {
  let mode = 0o644;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch {}
  const tmp = join(dirname(file), `.${basename(file)}.gnash-${randomBytes(6).toString("hex")}`);
  const fh = await open(tmp, "wx", mode);
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function pruneBackups(root: string): Promise<void> {
  const all = (await readdir(root)).sort(); // ISO names sort by time
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) {
    await rm(join(root, old), { recursive: true, force: true });
  }
}
