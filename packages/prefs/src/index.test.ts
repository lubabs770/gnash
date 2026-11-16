import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parsePrefs, PrefsFile, SECTION_MARKER } from "./index.ts";

const USER_JS = [
  "// my user.js",
  'user_pref("browser.startup.homepage", "https://example.com/a//b"); // home',
  "/* block comment",
  'user_pref("commented.out.block", true);',
  "*/",
  '// user_pref("commented.out.line", true);',
  '# user_pref("commented.out.hash", true);',
  "user_pref('single.quoted', 'it\\'s \\x41\\u0042');",
  'user_pref("int.neg", -5);',
  'user_pref("dup", 1);',
  '  user_pref( "dup" , 2 ) ;',
  'user_pref("a", true); user_pref("b", false);',
].join("\r\n");

describe("PrefsFile", () => {
  test("round-trips byte-for-byte", () => {
    for (const text of [USER_JS, USER_JS + "\r\n", "", "\n\n", "user_pref(\"x\", 1);\nmixed\r\n"]) {
      assert.equal(new PrefsFile(text).toString(), text);
    }
  });

  test("parses values and ignores comments", () => {
    const f = new PrefsFile(USER_JS);
    assert.deepEqual(Object.fromEntries(f.prefs), {
      "browser.startup.homepage": "https://example.com/a//b",
      "single.quoted": "it's AB",
      "int.neg": -5,
      dup: 2,
      a: true,
      b: false,
    });
  });

  test("set updates in place and keeps trailing comment", () => {
    const f = new PrefsFile(USER_JS);
    f.set("browser.startup.homepage", "about:home");
    assert.equal(f.toString().split("\r\n")[1], 'user_pref("browser.startup.homepage", "about:home"); // home');
    assert.equal(f.toString().split("\r\n")[0], "// my user.js");
  });

  test("set updates every duplicate", () => {
    const f = new PrefsFile(USER_JS);
    f.set("dup", 3);
    assert.deepEqual(f.all.filter((p) => p.name === "dup").map((p) => p.value), [3, 3]);
  });

  test("set appends new prefs under one marker, matching line endings", () => {
    const f = new PrefsFile(USER_JS);
    f.set("new.one", "x\"y");
    f.set("new.two", false);
    const out = f.toString();
    assert.ok(out.endsWith(`${SECTION_MARKER}\r\nuser_pref("new.one", "x\\"y");\r\nuser_pref("new.two", false);\r\n`));
    assert.equal(out.split(SECTION_MARKER).length, 2);
    assert.equal(new PrefsFile(out).get("new.one"), 'x"y');
  });

  test("set on empty file", () => {
    const f = new PrefsFile("");
    f.set("k", 1);
    assert.equal(f.toString(), `${SECTION_MARKER}\nuser_pref("k", 1);\n`);
  });

  test("remove drops the whole line with its comment", () => {
    const f = new PrefsFile(USER_JS);
    assert.ok(f.remove("browser.startup.homepage"));
    assert.ok(!f.toString().includes("// home"));
    assert.equal(f.toString().split("\r\n")[1], "/* block comment");
  });

  test("remove on a shared line keeps the other statement", () => {
    const f = new PrefsFile(USER_JS);
    f.remove("a");
    assert.equal(f.get("a"), undefined);
    assert.equal(f.get("b"), false);
  });

  test("remove keeps a line that opens a block comment", () => {
    const f = new PrefsFile('user_pref("x", 1); /* start\nuser_pref("hidden", 1);\n*/\n');
    f.remove("x");
    assert.equal(f.get("hidden"), undefined);
  });

  test("multi-line statements parse, edit and remove", () => {
    const text = '// x\nuser_pref("long",\n  "value");\nuser_pref("next", 1);\n';
    const f = new PrefsFile(text);
    assert.equal(f.get("long"), "value");
    f.set("long", "v2");
    assert.equal(f.toString(), '// x\nuser_pref("long", "v2");\nuser_pref("next", 1);\n');
    const g = new PrefsFile(text);
    g.remove("long");
    assert.equal(g.toString(), '// x\nuser_pref("next", 1);\n');
  });

  test("rejects non-integer numbers", () => {
    assert.throws(() => new PrefsFile("").set("f", 1.5));
  });
});

describe("parsePrefs", () => {
  test("reads default-file syntax", () => {
    const prefs = parsePrefs('pref("a", 1);\nsticky_pref("b", true);\npref("c", "x", locked);\n#ifdef X\nlockPref("d", false);\n');
    assert.deepEqual(
      prefs.map((p) => [p.kind, p.name, p.value]),
      [["pref", "a", 1], ["sticky_pref", "b", true], ["pref", "c", "x"], ["lockPref", "d", false]],
    );
  });
});
