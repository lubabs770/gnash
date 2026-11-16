// Parser and editor for Firefox prefs files (prefs.js, user.js, default pref files).
// PrefsFile keeps the original text and splices only the spans it edits,
// so toString() of an unedited file is byte-identical to the input.

export type PrefValue = string | number | boolean;
export type PrefKind = "user_pref" | "pref" | "sticky_pref" | "lockPref";

export interface Pref {
  kind: PrefKind;
  name: string;
  value: PrefValue;
  /** character span of the whole statement in the text */
  start: number;
  end: number;
}

export const SECTION_MARKER = "// --- added by gnash ---";

const STR = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;
const STMT = new RegExp(
  String.raw`\b(user_pref|pref|sticky_pref|lockPref)\s*\(\s*(${STR})\s*,\s*(${STR}|true|false|[+-]?\d+)` +
    String.raw`(?:\s*,\s*(?:locked|sticky))*\s*\)\s*;?`,
  "g",
);

/** Replace comments with spaces, keeping newlines, string contents and every offset. */
function maskComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  let comment: "line" | "block" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (comment === "line") {
      if (c === "\n") comment = null;
      out += c === "\n" ? c : " ";
    } else if (comment === "block") {
      if (c === "*" && n === "/") {
        comment = null;
        out += "  ";
        i++;
      } else out += c === "\n" ? c : " ";
    } else if (quote) {
      out += c;
      if (c === "\\" && n !== undefined) {
        out += n;
        i++;
      } else if (c === quote || c === "\n") quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === "/" && n === "*") {
      comment = "block";
      out += "  ";
      i++;
    } else if ((c === "/" && n === "/") || c === "#") {
      comment = "line";
      out += " ";
    } else out += c;
  }
  return out;
}

function decodeString(lit: string): string {
  return lit.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_, e: string) => {
    if (e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    return e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e;
  });
}

function decodeValue(lit: string): PrefValue {
  if (lit === "true") return true;
  if (lit === "false") return false;
  if (lit[0] === '"' || lit[0] === "'") return decodeString(lit);
  return parseInt(lit, 10);
}

/** All pref statements in file order, duplicates included; commented-out ones are skipped. */
export function parsePrefs(text: string): Pref[] {
  return [...maskComments(text).matchAll(STMT)].map((m) => ({
    kind: m[1] as PrefKind,
    name: decodeString(m[2]!),
    value: decodeValue(m[3]!),
    start: m.index!,
    end: m.index! + m[0].length,
  }));
}

/** Last occurrence wins, as in Firefox. */
export function toMap(prefs: readonly Pref[]): Map<string, PrefValue> {
  return new Map(prefs.map((p) => [p.name, p.value]));
}

export function formatValue(value: PrefValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (!Number.isSafeInteger(value)) throw new TypeError(`Firefox int prefs must be integers, got ${value}`);
  return String(value);
}

export function formatPref(name: string, value: PrefValue): string {
  return `user_pref(${JSON.stringify(name)}, ${formatValue(value)});`;
}

export class PrefsFile {
  private text: string;
  private parsed: Pref[];

  constructor(text: string) {
    this.text = text;
    this.parsed = parsePrefs(text);
  }

  private splice(start: number, end: number, insert = ""): void {
    this.text = this.text.slice(0, start) + insert + this.text.slice(end);
  }

  /** Every statement in file order, duplicates included. */
  get all(): readonly Pref[] {
    return this.parsed;
  }

  get prefs(): Map<string, PrefValue> {
    return toMap(this.parsed);
  }

  get(name: string): PrefValue | undefined {
    return this.prefs.get(name);
  }

  /** Rewrite every occurrence in place, or append under the gnash section. */
  set(name: string, value: PrefValue): void {
    const stmt = formatPref(name, value);
    const hits = this.parsed.filter((p) => p.name === name);
    if (hits.length) {
      for (const p of hits.reverse()) this.splice(p.start, p.end, stmt);
    } else {
      const eol = this.text.includes("\r\n") ? "\r\n" : "\n";
      if (this.text && !this.text.endsWith("\n")) this.text += eol;
      if (!this.text.split(/\r?\n/).some((l) => l.trim() === SECTION_MARKER)) {
        this.text += (this.text ? eol : "") + SECTION_MARKER + eol;
      }
      this.text += stmt + eol;
    }
    this.parsed = parsePrefs(this.text);
  }

  /** Remove every occurrence. A line left with no code (only a `//` comment) goes too. */
  remove(name: string): boolean {
    const hits = this.parsed.filter((p) => p.name === name);
    for (const p of [...hits].reverse()) {
      const lineStart = this.text.lastIndexOf("\n", p.start - 1) + 1;
      const nl = this.text.indexOf("\n", p.end);
      const lineEnd = nl === -1 ? this.text.length : nl + 1;
      const rest = (this.text.slice(lineStart, p.start) + this.text.slice(p.end, lineEnd)).trim();
      // A leftover `/*` must stay, or the block comment it opens would swallow later lines.
      const dropLine = rest === "" || ((rest.startsWith("//") || rest.startsWith("#")) && !rest.includes("/*"));
      if (dropLine) this.splice(lineStart, lineEnd);
      else this.splice(p.start, p.end);
    }
    this.parsed = parsePrefs(this.text);
    return hits.length > 0;
  }

  toString(): string {
    return this.text;
  }
}
