// Entry point: start the loopback server and open the browser. A restart reuses the previous
// port and token when it can, so an open gnash tab simply reconnects.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";
import { stopCurrent } from "./live.ts";
import { loadDrafts, persistDrafts, readSessionFile, writeSession } from "./session.ts";

const IDLE_MS = 10 * 60_000; // the UI pings every 30s while a tab is open

const prev = await readSessionFile();
const token = prev?.token && prev.token.length >= 32 ? prev.token : randomBytes(32).toString("base64url");
let lastActivity = Date.now();
const server = createApp({
  token,
  onActivity: () => (lastActivity = Date.now()),
  drafts: await loadDrafts(),
  onDraftsChange: persistDrafts,
});

function listen(port: number, tries = 10): void {
  server.once("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE" || port === 0) throw e;
    // The previous gnash may still be letting go of the port; wait a little, then pick any.
    if (tries > 0) return void setTimeout(() => listen(port, tries - 1), 300);
    console.error(`Port ${port} is busy; using another one. Open gnash tabs will need the new link.`);
    listen(0);
  });
  server.listen(port, "127.0.0.1", () => {
    const { port: actual } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${actual}/?token=${token}`;
    void writeSession({ port: actual, token, pid: process.pid });
    console.log(`gnash is running. If your browser didn't open, visit:\n  ${url}\nPress Ctrl-C to stop.`);
    if (!process.argv.includes("--no-open")) openBrowser(url);
  });
}
listen(prev?.port ?? 0);

setInterval(() => {
  if (Date.now() - lastActivity > IDLE_MS) {
    console.log("No open gnash tab for a while; shutting down.");
    void shutdown();
  }
}, 30_000).unref();

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  execFile(cmd, args, (err) => err && console.error(`Could not open a browser: ${err.message}`));
}

/** Close the live copy, then exit. The session file stays so the next start can reuse it. */
async function shutdown(): Promise<void> {
  await Promise.race([stopCurrent(), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
