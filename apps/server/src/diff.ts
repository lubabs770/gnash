// Minimal line diff in unified format, for showing a change before it is written.

type Op = { t: " " | "-" | "+"; s: string };

function ops(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const mid: Op[] = [];
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) {
    // ponytail: huge rewrites show as remove-all/add-all; switch to Myers if that ever matters.
    mid.push(...A.map((s) => ({ t: "-" as const, s })), ...B.map((s) => ({ t: "+" as const, s })));
  } else {
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i * (m + 1) + j] =
          A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(L[(i + 1) * (m + 1) + j]!, L[i * (m + 1) + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) (mid.push({ t: " ", s: A[i]! }), i++, j++);
      else if (i < n && (j === m || L[(i + 1) * (m + 1) + j]! >= L[i * (m + 1) + j + 1]!)) mid.push({ t: "-", s: A[i++]! });
      else mid.push({ t: "+", s: B[j++]! });
    }
  }
  return [
    ...a.slice(0, pre).map((s) => ({ t: " " as const, s })),
    ...mid,
    ...a.slice(a.length - suf).map((s) => ({ t: " " as const, s })),
  ];
}

/** Unified diff with `context` lines around each change; "" when nothing changed. */
export function unifiedDiff(before: string, after: string, label: string, context = 3): string {
  if (before === after) return "";
  const split = (t: string) => (t === "" ? [] : t.replace(/\r?\n$/, "").split(/\r?\n/));
  const all = ops(split(before), split(after));
  const changed = all.flatMap((o, i) => (o.t === " " ? [] : [i]));
  const out = [`--- a/${label}`, `+++ b/${label}`];
  for (let c = 0; c < changed.length; c++) {
    const first = changed[c]!;
    let last = first;
    // Merge changes whose gap of unchanged lines would overlap their context.
    while (c + 1 < changed.length && changed[c + 1]! - last <= 2 * context + 1) last = changed[++c]!;
    const start = Math.max(0, first - context);
    const hunk = all.slice(start, Math.min(all.length, last + context + 1));
    const prior = all.slice(0, start);
    const count = (xs: Op[], skip: Op["t"]) => xs.filter((o) => o.t !== skip).length;
    out.push(
      `@@ -${count(prior, "+") + 1},${count(hunk, "+")} +${count(prior, "-") + 1},${count(hunk, "-")} @@`,
      ...hunk.map((o) => o.t + o.s),
    );
  }
  return out.join("\n") + "\n";
}
