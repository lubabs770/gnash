import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("drafts and session survive a restart, owner-only", async () => {
  process.env.GNASH_HOME = await mkdtemp(join(tmpdir(), "gnash-home-"));
  const s = await import("./session.ts");
  s.persistDrafts(new Map([["abc:userChrome", "#nav-bar{}"]]));
  await s.writeSession({ port: 4321, token: "t".repeat(43), pid: 1 });
  await new Promise((r) => setTimeout(r, 300)); // persistDrafts is debounced
  assert.deepEqual([...(await s.loadDrafts())], [["abc:userChrome", "#nav-bar{}"]]);
  assert.equal((await s.readSessionFile())?.port, 4321);
  for (const f of ["drafts.json", "session.json"]) assert.equal((await stat(join(process.env.GNASH_HOME, f))).mode & 0o777, 0o600);
});
