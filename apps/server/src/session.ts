// Where a running gnash leaves its port and token so local tools (the MCP server) can reach it,
// and where unsaved drafts are kept so a restart doesn't lose them. All owner-only.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const GNASH_HOME = process.env.GNASH_HOME ?? join(homedir(), ".gnash");
export const SESSION_FILE = join(GNASH_HOME, "session.json");
const DRAFTS_FILE = join(GNASH_HOME, "drafts.json");

export type Session = { port: number; token: string; pid: number };

async function writePrivate(file: string, text: string): Promise<void> {
  await mkdir(GNASH_HOME, { recursive: true, mode: 0o700 });
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600); // the mode above only applies when the file is new
}

/** The token is as good as the browser cookie, hence owner-only. */
export const writeSession = (s: Session) => writePrivate(SESSION_FILE, JSON.stringify(s));

/** Last session, alive or not; a restart reuses its port and token so open tabs reconnect. */
export async function readSessionFile(): Promise<Session | null> {
  try {
    return JSON.parse(await readFile(SESSION_FILE, "utf8")) as Session;
  } catch {
    return null;
  }
}

export async function loadDrafts(): Promise<Map<string, string>> {
  try {
    return new Map(Object.entries(JSON.parse(await readFile(DRAFTS_FILE, "utf8")) as Record<string, string>));
  } catch {
    return new Map();
  }
}

let pending: NodeJS.Timeout | undefined;
/** Debounced: typing produces a draft every few hundred ms. */
export function persistDrafts(drafts: Map<string, string>): void {
  clearTimeout(pending);
  pending = setTimeout(() => void writePrivate(DRAFTS_FILE, JSON.stringify(Object.fromEntries(drafts))).catch(() => {}), 200);
}
