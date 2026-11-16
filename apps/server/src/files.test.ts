import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isFileKey, ProfileWatcher, readFiles, saveFile } from "./files.ts";
import { BACKUP_DIR, ConflictError } from "./store.ts";

test("save creates chrome/, backs up, and refuses stale hashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gnash-files-"));
  const before = await readFiles(dir);
  assert.equal(before.userChrome.text, "");
  const saved = await saveFile(dir, "userChrome", "#nav-bar{}", before.userChrome.hash);
  assert.equal(await readFile(join(dir, "chrome", "userChrome.css"), "utf8"), "#nav-bar{}");
  await assert.rejects(saveFile(dir, "userChrome", "x", before.userChrome.hash), ConflictError);
  await saveFile(dir, "userChrome", "#nav-bar{color:red}", saved.hash);
  const backups = await readdir(join(dir, BACKUP_DIR));
  assert.ok(backups.length >= 1);
  assert.ok(!isFileKey("../../etc/passwd") && !isFileKey("toString") && isFileKey("userJs"));
});

test("watcher reports edits made elsewhere, not gnash's own saves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gnash-watch-"));
  await writeFile(join(dir, "user.js"), "a");
  const seen: string[] = [];
  const w = new ProfileWatcher(dir, (key, f) => seen.push(`${key}:${f.text}`));
  await w.start();
  const files = await readFiles(dir);
  const ours = await saveFile(dir, "userJs", "ours", files.userJs.hash);
  w.note("userJs", ours.hash);
  await w.check();
  await writeFile(join(dir, "user.js"), "nvim");
  await w.check();
  await w.check(); // same content again: no duplicate
  w.close();
  assert.deepEqual(seen, ["userJs:nvim"]);
});
