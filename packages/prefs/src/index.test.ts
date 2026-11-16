import { describe, expect, test } from "bun:test";
import { PrefsFile, SECTION_MARKER } from "./index";

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
      expect(new PrefsFile(text).toString()).toBe(text);
    }
  });

  test("parses values and ignores comments", () => {
    const f = new PrefsFile(USER_JS);
    expect(Object.fromEntries(f.prefs)).toEqual({
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
    expect(f.toString().split("\r\n")[1]).toBe('user_pref("browser.startup.homepage", "about:home"); // home');
    expect(f.toString().split("\r\n")[0]).toBe("// my user.js");
  });

  test("set updates every duplicate", () => {
    const f = new PrefsFile(USER_JS);
    f.set("dup", 3);
    expect(f.all.filter((p) => p.name === "dup").map((p) => p.value)).toEqual([3, 3]);
  });

  test("set appends new prefs under one marker, matching line endings", () => {
    const f = new PrefsFile(USER_JS);
    f.set("new.one", "x\"y");
    f.set("new.two", false);
    const out = f.toString();
    expect(out.endsWith(`${SECTION_MARKER}\r\nuser_pref("new.one", "x\\"y");\r\nuser_pref("new.two", false);\r\n`)).toBe(true);
    expect(out.split(SECTION_MARKER).length).toBe(2);
    expect(new PrefsFile(out).get("new.one")).toBe('x"y');
  });

  test("set on empty file", () => {
    const f = new PrefsFile("");
    f.set("k", 1);
    expect(f.toString()).toBe(`${SECTION_MARKER}\nuser_pref("k", 1);\n`);
  });

  test("remove drops the whole line with its comment", () => {
    const f = new PrefsFile(USER_JS);
    expect(f.remove("browser.startup.homepage")).toBe(true);
    expect(f.toString()).not.toContain("// home");
    expect(f.toString().split("\r\n")[1]).toBe("/* block comment");
  });

  test("remove on a shared line keeps the other statement", () => {
    const f = new PrefsFile(USER_JS);
    f.remove("a");
    expect(f.get("a")).toBeUndefined();
    expect(f.get("b")).toBe(false);
  });

  test("remove keeps a line that opens a block comment", () => {
    const f = new PrefsFile('user_pref("x", 1); /* start\nuser_pref("hidden", 1);\n*/\n');
    f.remove("x");
    expect(f.get("hidden")).toBeUndefined();
  });

  test("rejects non-integer numbers", () => {
    expect(() => new PrefsFile("").set("f", 1.5)).toThrow();
  });
});
