import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { describe, test } from "node:test";
import CONTROLS from "../../../data/controls.json" with { type: "json" };
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveClosedError, LiveError, LiveSession, makeScratchProfile, Marionette, unparsedLines } from "./live.ts";

/** A fake Firefox: speaks the Marionette framing and keeps a pref store. */
async function fakeFirefox(prefs: Record<string, unknown>) {
  const log: string[] = [];
  const sockets: Socket[] = [];
  const frame = (v: unknown) => {
    const b = Buffer.from(JSON.stringify(v));
    return Buffer.concat([Buffer.from(`${b.length}:`), b]);
  };
  const server = createServer((s) => {
    sockets.push(s);
    s.write(frame({ applicationType: "gecko", marionetteProtocol: 3 }));
    let buf = Buffer.alloc(0);
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const c = buf.indexOf(0x3a);
        if (c < 0) return;
        const len = Number(buf.toString("ascii", 0, c));
        if (buf.length < c + 1 + len) return;
        const [, id, name, params] = JSON.parse(buf.toString("utf8", c + 1, c + 1 + len));
        buf = buf.subarray(c + 1 + len);
        log.push(name);
        let result: unknown = null;
        if (name === "Marionette:SetContext" && prefs.__denyChrome) {
          s.write(frame([1, id, { error: "unsupported operation", message: "System access is required" }, null]));
          continue;
        }
        if (name === "WebDriver:ExecuteScript") {
          const { script, args } = params as { script: string; args: unknown[] };
          if (script.includes("getDefaultBranch")) {
            result = { value: (args[0] as string[]).map((n) => ({ name: n, value: prefs[n] ?? null, def: null, hasUser: n in prefs })) };
          } else if (!script.includes("setIntPref")) {
            const kind = script.includes("style-sheet-service") ? "content" : "chrome";
            log.push(`css ${kind} ${args[0] ?? "none"}`);
            result = { value: true };
          } else {
            const [n, v] = args as [string, unknown];
            if (n === "bad") {
              s.write(frame([1, id, { error: "javascript error", message: "type mismatch" }, null]));
              continue;
            }
            if (v === null) delete prefs[n];
            else prefs[n] = v;
            log.push(`set ${n}=${JSON.stringify(v)}`);
            result = { value: true };
          }
        }
        s.write(frame([1, id, null, result]));
        if (name === "Marionette:Quit") s.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    log,
    closed: () => new Promise<void>((r) => sockets[0]!.once("close", () => r())),
    kill: () => (sockets.forEach((s) => s.destroy()), server.close()),
  };
}

describe("LiveSession", () => {
  test("sets live, reverts to original user values, keeps saved ones", async () => {
    const prefs: Record<string, unknown> = { a: 1 };
    const ff = await fakeFirefox(prefs);
    const s = await LiveSession.open("p", await Marionette.connect(ff.port));
    assert.deepEqual(ff.log.slice(0, 2), ["WebDriver:NewSession", "Marionette:SetContext"]);

    await s.set("a", 5);
    await s.set("a", 6); // original recorded once
    await s.set("b", true);
    await s.set("c", "x");
    s.keep(["c"]);
    assert.deepEqual(prefs, { a: 6, b: true, c: "x" });

    await s.revert();
    assert.deepEqual(prefs, { a: 1, c: "x" }); // a restored, b cleared, c kept
    await s.stop();
    assert.ok(ff.log.includes("Marionette:Quit"));
    ff.kill();
  });

  test("Firefox errors and closed connections surface as typed errors", async () => {
    const ff = await fakeFirefox({});
    const s = await LiveSession.open("p", await Marionette.connect(ff.port));
    await assert.rejects(s.set("bad", 1), LiveError);
    ff.kill();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(s.isClosed);
    await assert.rejects(s.set("a", 1), LiveClosedError);
  });
});

describe("controls.json", () => {
  const kinds = { bool: "boolean", int: "number", string: "string" } as const;
  for (const c of CONTROLS as Record<string, any>[]) {
    test(c.pref, () => {
      assert.ok(c.group && c.label && c.pref, "group, label, pref");
      assert.ok(["toggle", "slider", "choice", "color"].includes(c.control), "control");
      assert.ok(["instant", "new-tabs", "restart"].includes(c.applies), "applies");
      const t = kinds[c.type as keyof typeof kinds];
      assert.ok(t, "type");
      assert.ok("fallbackDefault" in c, "fallbackDefault");
      if (c.fallbackDefault !== null) assert.equal(typeof c.fallbackDefault, t);
      if (c.control === "toggle") assert.equal(c.type, "bool");
      if (c.control === "slider") assert.ok(c.min < c.max && c.step > 0, "slider range");
      if (c.control === "color") assert.match(c.fallbackDefault, /^#[0-9a-fA-F]{6}$/);
      if (c.control === "choice") {
        assert.ok(c.options.length >= 2, "options");
        for (const o of c.options) assert.ok(o.value === null || typeof o.value === t, `option ${o.label} type`);
      }
    });
  }
});

describe("LiveSession.open", () => {
  test("a refused session frees Firefox's single Marionette slot", async () => {
    const ff = await fakeFirefox({ __denyChrome: true });
    const m = await Marionette.connect(ff.port);
    const closed = ff.closed();
    await assert.rejects(LiveSession.open("p", m), LiveError);
    await closed; // resolves only if gnash closed its end
    ff.kill();
  });
});

describe("syncUserJs", () => {
  test("sets changes, clears removed lines, reports unknown and unparsed", async () => {
    const prefs: Record<string, unknown> = { a: 1, gone: true };
    const ff = await fakeFirefox(prefs);
    const s = await LiveSession.open("p", await Marionette.connect(ff.port));
    s.primeUserJs('user_pref("a", 1);\nuser_pref("gone", true);\n');
    const r = await s.syncUserJs('user_pref("a", 2);\nuser_pref("typo.pref", "x");\nuser_pref("broken", );\n// user_pref("commented", 1);\n');
    assert.deepEqual(prefs, { a: 2, "typo.pref": "x" });
    assert.deepEqual(r.unknown, ["typo.pref"]);
    assert.deepEqual(r.errors, [{ line: 3, message: "didn't parse" }]);
    assert.equal(r.changed, 3); // a set, typo.pref set, gone cleared
    const again = await s.syncUserJs('user_pref("a", 2);\nuser_pref("typo.pref", "x");\n');
    assert.equal(again.changed, 0); // nothing to do when Firefox already matches
    ff.kill();
  });

  test("unparsedLines ignores comments", () => {
    assert.deepEqual(unparsedLines('user_pref("ok", 1);\n  user_pref(oops\n# user_pref(x\n * user_pref(y\n'), [2]);
  });
});

describe("syncCss", () => {
  test("writes a versioned file into the copy and swaps it, removing the old one", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "gnash-scratch-"));
    const ff = await fakeFirefox({});
    const s = await LiveSession.open("p", await Marionette.connect(ff.port), scratch);
    await s.syncCss("chrome", "#nav-bar { color: red }");
    const first = ff.log.filter((l) => l.startsWith("css chrome"))[0]!.split(" ")[2]!;
    assert.equal(readFileSync(fileURLToPath(first), "utf8"), "#nav-bar { color: red }");
    await s.syncCss("chrome", "#nav-bar { color: green }");
    assert.ok(!existsSync(fileURLToPath(first)), "old version removed");
    await s.syncCss("content", "");
    assert.ok(ff.log.includes("css content none"), "empty CSS unloads the sheet");
    ff.kill();
  });
});

describe("makeScratchProfile", () => {
  test("copies prefs, layout and chrome assets but not the two CSS files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gnash-real-"));
    await mkdir(join(dir, "chrome", "img"), { recursive: true });
    await writeFile(join(dir, "prefs.js"), "p");
    await writeFile(join(dir, "xulstore.json"), "{}");
    await writeFile(join(dir, "chrome", "userChrome.css"), "x");
    await writeFile(join(dir, "chrome", "userContent.css"), "x");
    await writeFile(join(dir, "chrome", "img", "a.svg"), "<svg/>");
    await writeFile(join(dir, "cookies.sqlite"), "private");
    await mkdir(join(dir, "storage", "default", "moz-extension+++abc", "idb"), { recursive: true });
    await writeFile(join(dir, "storage", "default", "moz-extension+++abc", "idb", "x.sqlite"), "ext");
    await mkdir(join(dir, "storage", "default", "https+++bank.example"), { recursive: true });
    const id = "abcdef012345";
    const scratch = await makeScratchProfile({ id, browser: "Firefox", name: "t", dir, isDefault: false, installDirs: [] });
    assert.deepEqual((await readdir(scratch)).sort(), ["chrome", "prefs.js", "storage", "user.js", "xulstore.json"]);
    assert.deepEqual(await readdir(join(scratch, "storage", "default")), ["moz-extension+++abc"], "extension storage only, no site data");
    assert.match(readFileSync(join(scratch, "user.js"), "utf8"), /user_pref\("marionette.port", 0\);/);
    assert.deepEqual(await readdir(join(scratch, "chrome")), ["img"]);
    await rm(scratch, { recursive: true, force: true });
  });
});
