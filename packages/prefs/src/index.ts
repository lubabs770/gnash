// Parser and editor for Firefox prefs.js / user.js.
// Keeps the original text and edits only the spans it must, so
// toString() of an unedited file is byte-identical to the input.

export type PrefValue = string | number | boolean;

export interface Pref {
  name: string;
  value: PrefValue;
  /** 0-based line index */
  line: number;
  /** character span of the statement within the line */
  start: number;
  end: number;
}

export const SECTION_MARKER = "// --- added by gnash ---";

const STR = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const STMT = new RegExp(
  String.raw`\buser_pref\s*\(\s*(${STR})\s*,\s*(${STR}|true|false|[+-]?\d+)\s*\)\s*;?`,
  "g",
);

/** Blank out comments (keeping string contents and column positions). */
function maskComments(line: string, inBlock: boolean): { code: string; inBlock: boolean } {
  let code = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const n = line[i + 1];
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        code += "  ";
        i++;
      } else code += " ";
      continue;
    }
    if (quote) {
      code += c;
      if (c === "\\" && n !== undefined) {
        code += n;
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      code += c;
    } else if (c === "/" && n === "*") {
      inBlock = true;
      code += "  ";
      i++;
    } else if ((c === "/" && n === "/") || c === "#") {
      code += " ".repeat(line.length - i);
      break;
    } else code += c;
  }
  return { code, inBlock };
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

export function formatValue(value: PrefValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (!Number.isInteger(value)) throw new TypeError(`Firefox int prefs must be integers, got ${value}`);
  return String(value);
}

export function formatPref(name: string, value: PrefValue): string {
  return `user_pref(${JSON.stringify(name)}, ${formatValue(value)});`;
}

/** Split into [content, terminator] pairs so any line ending survives untouched. */
function splitLines(text: string): { content: string; eol: string }[] {
  return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((raw) => {
    const m = /\r?\n$/.exec(raw);
    return m ? { content: raw.slice(0, m.index), eol: m[0] } : { content: raw, eol: "" };
  });
}

export class PrefsFile {
  private lines: { content: string; eol: string }[];
  private parsed: Pref[] = [];

  constructor(text: string) {
    this.lines = splitLines(text);
    this.reparse();
  }

  private reparse(): void {
    this.parsed = [];
    let inBlock = false;
    this.lines.forEach(({ content }, line) => {
      const masked = maskComments(content, inBlock);
      inBlock = masked.inBlock;
      for (const m of masked.code.matchAll(STMT)) {
        this.parsed.push({
          name: decodeString(m[1]!),
          value: decodeValue(m[2]!),
          line,
          start: m.index!,
          end: m.index! + m[0].length,
        });
      }
    });
  }

  /** Every statement in file order, duplicates included. */
  get all(): readonly Pref[] {
    return this.parsed;
  }

  /** Effective prefs: the last occurrence of a name wins, as in Firefox. */
  get prefs(): Map<string, PrefValue> {
    return new Map(this.parsed.map((p) => [p.name, p.value]));
  }

  get(name: string): PrefValue | undefined {
    return this.prefs.get(name);
  }

  /** Update every occurrence in place, or append under the gnash section. */
  set(name: string, value: PrefValue): void {
    const stmt = formatPref(name, value);
    const hits = this.parsed.filter((p) => p.name === name);
    if (hits.length) {
      for (const p of [...hits].reverse()) {
        const l = this.lines[p.line]!;
        l.content = l.content.slice(0, p.start) + stmt + l.content.slice(p.end);
      }
    } else {
      const eol = this.lines.find((l) => l.eol)?.eol ?? "\n";
      const last = this.lines.at(-1);
      if (last && !last.eol) last.eol = eol;
      if (!this.lines.some((l) => l.content.trim() === SECTION_MARKER)) {
        if (this.lines.length) this.lines.push({ content: "", eol });
        this.lines.push({ content: SECTION_MARKER, eol });
      }
      this.lines.push({ content: stmt, eol });
    }
    this.reparse();
  }

  /** Remove every occurrence. A line left with no code (only a comment) goes too. */
  remove(name: string): boolean {
    const hits = this.parsed.filter((p) => p.name === name);
    const drop = new Set<number>();
    for (const p of [...hits].reverse()) {
      const l = this.lines[p.line]!;
      l.content = l.content.slice(0, p.start) + l.content.slice(p.end);
      const rest = l.content.trim();
      // Only drop lines left empty or holding a `//`/`#` comment; a `/*` must stay to keep block structure.
      if (rest === "" || ((rest.startsWith("//") || rest.startsWith("#")) && !rest.includes("/*"))) drop.add(p.line);
    }
    this.lines = this.lines.filter((_, i) => !drop.has(i));
    this.reparse();
    return hits.length > 0;
  }

  toString(): string {
    return this.lines.map((l) => l.content + l.eol).join("");
  }
}
