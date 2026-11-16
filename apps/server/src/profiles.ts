// Finds Firefox profiles from profiles.ini / installs.ini, and which install each one last ran with.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import PATHS from "../../../data/paths.json" with { type: "json" };

export interface Profile {
  /** Opaque id handed to the UI; the UI never sees file paths. */
  id: string;
  browser: string;
  name: string;
  dir: string;
  isDefault: boolean;
  version?: string;
  /** Install folders holding omni.ja, from compatibility.ini (GRE dir first, then app dir). */
  installDirs: string[];
}

export type Ini = Record<string, Record<string, string>>;

export function parseIni(text: string): Ini {
  const out: Ini = {};
  let section: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) out[head[1]!] = section = out[head[1]!] ?? {};
    else if (section) {
      const eq = line.indexOf("=");
      if (eq > 0) section[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return out;
}

function expand(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir()).replace(/%(\w+)%/g, (m, v: string) => process.env[v] ?? m);
}

async function readText(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Roots per browser for this OS, from data/paths.json. */
export function profileRoots(platform = process.platform): { browser: string; root: string }[] {
  return Object.entries(PATHS as Record<string, Record<string, string[]>>).flatMap(([browser, byOs]) =>
    (byOs[platform] ?? []).map((p) => ({ browser, root: resolve(expand(p)) })),
  );
}

export async function readProfilesIni(browser: string, root: string): Promise<Profile[]> {
  const text = await readText(join(root, "profiles.ini"));
  if (!text) return [];
  const ini = parseIni(text);
  const installs = parseIni((await readText(join(root, "installs.ini"))) ?? "");
  const sections = Object.entries(ini);

  // Install defaults live in both files; profiles.ini's legacy Default=1 only counts when no install names one.
  const installDefaults = new Set(
    [...sections.filter(([k]) => k.startsWith("Install")).map(([, s]) => s), ...Object.values(installs)]
      .map((s) => s.Default)
      .filter((d): d is string => !!d),
  );

  const profiles: Profile[] = [];
  for (const [key, s] of sections) {
    if (!/^Profile\d+$/.test(key) || !s.Path) continue;
    const dir = s.IsRelative === "1" || !isAbsolute(s.Path) ? resolve(root, s.Path) : s.Path;
    const compat = parseIni((await readText(join(dir, "compatibility.ini"))) ?? "").Compatibility ?? {};
    if (!compat.LastVersion && (await readText(join(dir, "prefs.js"))) === undefined) continue; // folder gone
    profiles.push({
      id: createHash("sha256").update(dir).digest("hex").slice(0, 12),
      browser,
      name: s.Name ?? s.Path,
      dir,
      isDefault: installDefaults.size ? installDefaults.has(s.Path) : s.Default === "1",
      version: compat.LastVersion?.split("_")[0],
      installDirs: [compat.LastPlatformDir, compat.LastAppDir].filter((d): d is string => !!d),
    });
  }
  return profiles;
}

export async function discoverProfiles(): Promise<Profile[]> {
  const found = (await Promise.all(profileRoots().map(({ browser, root }) => readProfilesIni(browser, root)))).flat();
  // Dev/testing only: a throwaway profile folder that is not in profiles.ini.
  const extra = process.env.GNASH_EXTRA_PROFILE;
  if (extra) {
    const dir = resolve(extra);
    const compat = parseIni((await readText(join(dir, "compatibility.ini"))) ?? "").Compatibility ?? {};
    const installDirs = [compat.LastPlatformDir, compat.LastAppDir].filter((d): d is string => !!d);
    found.push({
      id: createHash("sha256").update(dir).digest("hex").slice(0, 12),
      browser: "Firefox",
      name: "dev: extra profile",
      dir,
      isDefault: false,
      installDirs: installDirs.length ? installDirs : (found[0]?.installDirs ?? []),
    });
  }
  const seen = new Set<string>();
  return found.filter((p) => !seen.has(p.id) && !!seen.add(p.id));
}

/**
 * Best-effort "is Firefox using this profile right now". Returns null when it can't tell.
 */
export async function isRunning(p: Profile): Promise<boolean | null> {
  try {
    // Linux: `lock` is a symlink to "<ip>:+<pid>".
    const pid = Number((await readlink(join(p.dir, "lock"))).split("+")[1]);
    if (pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
  } catch {}
  if (process.platform === "darwin" && p.installDirs[0]) {
    // .parentlock persists on macOS, so look at this install's running processes instead:
    // one launched with this profile's folder, or one with no profile flag on the default profile.
    const bin = resolve(p.installDirs[0], "../MacOS/firefox");
    const { stdout } = await promisify(execFile)("ps", ["-axww", "-o", "args="]);
    return stdout
      .split("\n")
      .filter((l) => l.startsWith(bin + " ") || l === bin)
      .some((l) => l.includes(p.dir) || (p.isDefault && !/\s-(-?profile|P)\b/.test(l)));
  }
  return null;
}
