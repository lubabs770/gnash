// The three files the Studio edits, saving them safely, and watching them for edits made elsewhere (nvim).
import { watch, type FSWatcher } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hash, readOptional, writeWithBackup } from "./store.ts";

/** Fixed set; the client names a file by key and never sends a path. */
export const FILES = {
  userJs: "user.js",
  userChrome: "chrome/userChrome.css",
  userContent: "chrome/userContent.css",
} as const;
export type FileKey = keyof typeof FILES;
export const isFileKey = (k: unknown): k is FileKey => typeof k === "string" && Object.hasOwn(FILES, k);

export type FileState = { text: string; hash: string };

export async function readFiles(dir: string): Promise<Record<FileKey, FileState>> {
  const out = {} as Record<FileKey, FileState>;
  for (const [key, rel] of Object.entries(FILES) as [FileKey, string][]) {
    const text = await readOptional(join(dir, rel));
    out[key] = { text, hash: hash(text) };
  }
  return out;
}

export function saveFile(dir: string, key: FileKey, text: string, expectedHash: string) {
  return writeWithBackup(dir, FILES[key], text, expectedHash);
}

/**
 * Calls `onChange` when one of the files changes on disk. Hashes dedupe repeated events
 * and gnash's own saves (call `note` after saving). Follows symlinked files to their real folder.
 */
export class ProfileWatcher {
  private readonly dir: string;
  private readonly onChange: (key: FileKey, file: FileState) => void;
  private known = new Map<FileKey, string>();
  private watchers = new Map<string, FSWatcher>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(dir: string, onChange: (key: FileKey, file: FileState) => void) {
    this.dir = dir;
    this.onChange = onChange;
  }

  async start(): Promise<void> {
    const files = await readFiles(this.dir);
    for (const k of Object.keys(files) as FileKey[]) this.known.set(k, files[k].hash);
    await this.rewatch();
  }

  note(key: FileKey, h: string): void {
    this.known.set(key, h);
  }

  /** Watch the profile, its chrome/ folder, and the real folder of any symlinked file. */
  private async rewatch(): Promise<void> {
    const dirs = new Set([this.dir, join(this.dir, "chrome")]);
    for (const rel of Object.values(FILES)) {
      try {
        dirs.add(dirname(await realpath(join(this.dir, rel))));
      } catch {}
    }
    for (const d of dirs) {
      if (this.closed || this.watchers.has(d)) continue;
      try {
        this.watchers.set(d, watch(d, () => this.schedule()).on("error", () => this.watchers.delete(d)));
      } catch {} // folder doesn't exist yet (chrome/ before the first CSS save)
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), 150);
  }

  async check(): Promise<void> {
    if (this.closed) return;
    const files = await readFiles(this.dir);
    for (const k of Object.keys(files) as FileKey[]) {
      if (this.known.get(k) === files[k].hash) continue;
      this.known.set(k, files[k].hash);
      this.onChange(k, files[k]);
    }
    await this.rewatch(); // chrome/ may have just been created
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}
