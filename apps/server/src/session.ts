// Where a running gnash leaves its port and token so local tools (the MCP server) can reach it.
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SESSION_FILE = join(process.env.GNASH_HOME ?? join(homedir(), ".gnash"), "session.json");

export type Session = { port: number; token: string; pid: number };

/** Owner-only (0600 in a 0700 folder): the token is as good as the browser cookie. */
export async function writeSession(s: Session): Promise<void> {
  await mkdir(join(SESSION_FILE, ".."), { recursive: true, mode: 0o700 });
  await writeFile(SESSION_FILE, JSON.stringify(s), { mode: 0o600 });
  await chmod(SESSION_FILE, 0o600); // mode above only applies when the file is new
}

export async function removeSession(pid: number): Promise<void> {
  try {
    if ((JSON.parse(await readFile(SESSION_FILE, "utf8")) as Session).pid === pid) await rm(SESSION_FILE, { force: true });
  } catch {}
}
