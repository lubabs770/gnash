// Reads a profile's three pref layers and writes user.js changes: diff, backup, atomic write.
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PrefsFile, toMap, parsePrefs, type PrefValue } from "@gnash/prefs";
import { unifiedDiff } from "./diff.ts";

export const BACKUP_DIR = ".gnash-backups";
const KEEP_BACKUPS = 30;

export type Change = { name: string; value: PrefValue | null };

export class ConflictError extends Error {}
export class ValidationError extends Error {}

export const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function readOptional(p: string): Promise<string> {
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
 * Returns the backup folder name.
 */
export async function apply(dir: string, changes: Change[], expectedHash: string): Promise<string> {
  const before = await readOptional(join(dir, "user.js"));
  if (hash(before) !== expectedHash) throw new ConflictError("user.js changed since the preview; review again");
  return (await writeWithBackup(dir, "user.js", applyTo(before, changes), expectedHash)).backup;
}

/**
 * Writes `rel` (relative to the profile) if it still matches `expectedHash`.
 * First copies it and prefs.js into .gnash-backups/<time>/, then writes atomically,
 * through symlinks (user.js is often linked from a dotfiles repo) so the link survives.
 */
export async function writeWithBackup(dir: string, rel: string, text: string, expectedHash: string) {
  const file = join(dir, rel);
  if (hash(await readOptional(file)) !== expectedHash) throw new ConflictError(`${rel} changed on disk`);

  const name = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(dir, BACKUP_DIR, name);
  for (const f of [...new Set([rel, "prefs.js"])]) {
    try {
      await mkdir(dirname(join(backup, f)), { recursive: true });
      await copyFile(join(dir, f), join(backup, f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  await pruneBackups(join(dir, BACKUP_DIR));

  let target = file;
  try {
    target = await realpath(file);
  } catch {
    await mkdir(dirname(file), { recursive: true });
  }
  await atomicWrite(target, text);
  return { backup: name, hash: hash(text) };
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
