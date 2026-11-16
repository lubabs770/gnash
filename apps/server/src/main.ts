// Entry point: start the loopback server on a random port and open the browser.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";
import { stopCurrent } from "./live.ts";

const IDLE_MS = 10 * 60_000; // the UI pings every 30s while a tab is open

const token = randomBytes(32).toString("base64url");
let lastActivity = Date.now();
const server = createApp({ token, onActivity: () => (lastActivity = Date.now()) });

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  console.log(`gnash is running. If your browser didn't open, visit:\n  ${url}\nPress Ctrl-C to stop.`);
  if (!process.argv.includes("--no-open")) openBrowser(url);
});

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

/** Undo live changes that weren't saved, then exit. */
async function shutdown(): Promise<void> {
  await Promise.race([stopCurrent(), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
