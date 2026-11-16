import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { describe, test } from "node:test";
import CONTROLS from "../../../data/controls.json" with { type: "json" };
import { LiveClosedError, LiveError, LiveSession, Marionette } from "./live.ts";

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

    await s.stop();
    assert.deepEqual(prefs, { a: 1, c: "x" }); // a restored, b cleared, c kept
    assert.ok(ff.log.includes("WebDriver:DeleteSession"));
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
