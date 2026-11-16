import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { createApp } from "./app.ts";
import { unifiedDiff } from "./diff.ts";
import { readZip } from "./omni.ts";
import { parseIni, type Profile } from "./profiles.ts";
import { apply, BACKUP_DIR, ConflictError, preview } from "./store.ts";

const tmp = () => mkdtemp(join(tmpdir(), "gnash-"));

describe("unifiedDiff", () => {
  test("separate hunks with context and correct headers", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") + "\n";
    const b = a.replace("l2\n", "L2\n").replace("l17\n", "") + "new\n";
    assert.equal(
      unifiedDiff(a, b, "f"),
      ["--- a/f", "+++ b/f", "@@ -1,6 +1,6 @@", " l0", " l1", "-l2", "+L2", " l3", " l4", " l5",
        "@@ -15,6 +15,6 @@", " l14", " l15", " l16", "-l17", " l18", " l19", "+new", ""].join("\n"),
    );
    assert.equal(unifiedDiff(a, a, "f"), "");
  });
});

describe("parseIni", () => {
  test("sections and keys", () => {
    assert.deepEqual(parseIni("[A]\r\nx=1\n; c\n[B]\ny = a=b\n"), { A: { x: "1" }, B: { y: "a=b" } });
  });
});

describe("readZip", () => {
  test("stored and deflated entries", () => {
    const files = [
      { name: "greprefs.js", data: Buffer.from('pref("a", 1);'), method: 0 },
      { name: "defaults/pref/x.js", data: Buffer.from('pref("b", "x");'), method: 8 },
    ];
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const f of files) {
      const body = f.method === 8 ? deflateRawSync(f.data) : f.data;
      const name = Buffer.from(f.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(f.method, 8);
      lh.writeUInt32LE(body.length, 18);
      lh.writeUInt32LE(f.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(f.method, 10);
      ch.writeUInt32LE(body.length, 20);
      ch.writeUInt32LE(f.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(offset, 42);
      locals.push(lh, name, body);
      central.push(ch, name);
      offset += 30 + name.length + body.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    const zip = readZip(Buffer.concat([...locals, cd, eocd]), () => true);
    assert.equal(zip.get("greprefs.js")?.toString(), 'pref("a", 1);');
    assert.equal(zip.get("defaults/pref/x.js")?.toString(), 'pref("b", "x");');
  });
});

describe("store", () => {
  test("apply backs up, writes, and keeps a symlinked user.js linked", async () => {
    const dir = await tmp();
    const real = join(await tmp(), "dotfiles-user.js");
    await writeFile(real, '// mine\nuser_pref("a", 1);\n');
    await symlink(real, join(dir, "user.js"));
    await writeFile(join(dir, "prefs.js"), 'user_pref("a", 1);\n');

    const changes = [{ name: "a", value: 2 }, { name: "b", value: "x" }];
    const { diff, hash } = await preview(dir, changes);
    assert.match(diff, /^-user_pref\("a", 1\);$/m);
    const backup = await apply(dir, changes, hash);

    assert.equal(await readlink(join(dir, "user.js")), real);
    assert.match(await readFile(real, "utf8"), /^\/\/ mine\nuser_pref\("a", 2\);\n/);
    assert.deepEqual((await readdir(join(dir, BACKUP_DIR, backup))).sort(), ["prefs.js", "user.js"]);
    assert.equal(await readFile(join(dir, BACKUP_DIR, backup, "user.js"), "utf8"), '// mine\nuser_pref("a", 1);\n');
  });

  test("apply refuses when user.js changed after preview", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "user.js"), 'user_pref("a", 1);\n');
    const { hash } = await preview(dir, [{ name: "a", value: 2 }]);
    await writeFile(join(dir, "user.js"), 'user_pref("a", 5);\n');
    await assert.rejects(apply(dir, [{ name: "a", value: 2 }], hash), ConflictError);
  });

  test("creates user.js when missing", async () => {
    const dir = await tmp();
    const { hash } = await preview(dir, [{ name: "a", value: true }]);
    await apply(dir, [{ name: "a", value: true }], hash);
    assert.match(await readFile(join(dir, "user.js"), "utf8"), /user_pref\("a", true\);/);
  });
});

describe("http security", () => {
  const token = "t".repeat(43);
  let base = "";
  let port = 0;
  const server = createApp({
    token,
    profiles: async () => [] as Profile[],
  });
  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  after(() => server.close());

  const cookie = `gnash_session=${token}`;

  test("token link sets an HttpOnly SameSite=Strict cookie", async () => {
    const res = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(`${base}/?token=wrong`, { redirect: "manual" })).status, 403);
  });

  test("API needs the cookie", async () => {
    assert.equal((await fetch(`${base}/api/profiles`)).status, 401);
    assert.equal((await fetch(`${base}/api/profiles`, { headers: { cookie } })).status, 200);
  });

  test("rejects a foreign Host (DNS rebinding)", async () => {
    // fetch won't let us set Host, so speak raw HTTP.
    const { connect } = await import("node:net");
    const reply = await new Promise<string>((resolve) => {
      const s = connect(port, "127.0.0.1", () =>
        s.end(`GET /api/profiles HTTP/1.1\r\nHost: evil.example:${port}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`),
      );
      let out = "";
      s.on("data", (d) => (out += d)).on("end", () => resolve(out));
    });
    assert.match(reply, /^HTTP\/1\.1 403/);
  });

  test("POST needs our Origin and a JSON body", async () => {
    const url = `${base}/api/profiles/000000000000/preview`;
    const body = JSON.stringify({ changes: [{ name: "a", value: 1 }] });
    const json = { cookie, "content-type": "application/json" };
    assert.equal((await fetch(url, { method: "POST", headers: { ...json, origin: "https://evil.example" }, body })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: { cookie, origin: base, "content-type": "text/plain" }, body })).status, 415);
    assert.equal((await fetch(url, { method: "POST", headers: { ...json, origin: base }, body })).status, 404); // passed the checks
  });

  test("page is served with a strict CSP", async () => {
    const res = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'nonce-[^']+'; .*frame-ancestors 'none'/);
    assert.ok(!res.headers.has("access-control-allow-origin"));
  });
});
