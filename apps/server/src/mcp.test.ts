import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "./mcp.ts";

function fakeGnash() {
  const files: Record<string, { text: string; hash: string; draft?: string }> = {
    userJs: { text: 'user_pref("a", 1);\n', hash: "h1" },
    userChrome: { text: "#nav-bar { color: red }\n", hash: "h2" },
    userContent: { text: "", hash: "h3" },
  };
  const calls: string[] = [];
  const api = async (path: string, body?: any) => {
    calls.push(`${body === undefined ? "GET" : "POST"} ${path}`);
    if (path === "/api/state") return { profiles: [{ id: "aaa", name: "default-release", isDefault: true }, { id: "bbb", name: "work" }], focus: "bbb", live: { active: false } };
    if (path.endsWith("/files")) return files;
    if (path.endsWith("/draft")) {
      files[body.file]!.draft = body.text;
      return { sync: { css: true }, unsaved: true };
    }
    if (path.endsWith("/files/save")) return { backup: "T", hash: "new" };
    if (/\/api\/profiles\/\w+$/.test(path)) return { rows: [{ name: "sidebar.verticalTabs", def: false }, { name: "browser.tabs.x", def: 1, user: 2 }] };
    throw new Error(`unexpected ${path}`);
  };
  return { api, files, calls };
}

const call = (h: any, name: string, args = {}) => h({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("handshake, tool list, and notifications", async () => {
  const h = createHandler(fakeGnash().api);
  const init: any = await h({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.capabilities.tools);
  assert.equal(await h({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  const list: any = await h({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(list.result.tools.some((t: any) => t.name === "screenshot"));
  const bad: any = await h({ jsonrpc: "2.0", id: 3, method: "nope" });
  assert.equal(bad.error.code, -32601);
});

test("edits go to the profile open in gnash as drafts; edit_file needs one exact match", async () => {
  const g = fakeGnash();
  const h = createHandler(g.api);
  const r: any = await call(h, "edit_file", { file: "userChrome.css", old_string: "red", new_string: "blue" });
  assert.match(r.result.content[0].text, /CSS applied live/);
  assert.equal(g.files.userChrome!.draft, "#nav-bar { color: blue }\n");
  assert.ok(g.calls.includes("POST /api/profiles/bbb/draft"), "defaults to the focused profile");
  const miss: any = await call(h, "edit_file", { file: "userChrome.css", old_string: "green", new_string: "x" });
  assert.equal(miss.result.isError, true);
  const read: any = await call(h, "read_file", { file: "userChrome.css" });
  assert.match(read.result.content[0].text, /unsaved draft[\s\S]*blue/);
});

test("save only writes when there is a draft; search filters by all words; bad file names rejected", async () => {
  const g = fakeGnash();
  const h = createHandler(g.api);
  assert.match((await call(h, "save_file", { file: "user.js" }) as any).result.content[0].text, /no unsaved changes/);
  await call(h, "write_file", { file: "user.js", content: 'user_pref("a", 2);\n' });
  assert.match((await call(h, "save_file", { file: "user.js" }) as any).result.content[0].text, /Saved user.js/);
  const s: any = await call(h, "search_prefs", { query: "vertical tabs" });
  assert.match(s.result.content[0].text, /^1 match:\nsidebar.verticalTabs  default=false/);
  const bad: any = await call(h, "read_file", { file: "../prefs.js" });
  assert.equal(bad.result.isError, true);
  const named: any = await call(h, "read_file", { file: "user.js", profile: "Default-Release" });
  assert.ok(!named.result.isError && g.calls.includes("GET /api/profiles/aaa/files"));
});
