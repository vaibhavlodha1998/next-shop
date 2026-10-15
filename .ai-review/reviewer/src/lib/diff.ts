/**
 * Parses the per-file unified patch GitHub returns (pulls.listFiles -> file.patch)
 * and renders it with explicit new-file line numbers, so the model can cite lines
 * and we can check those citations deterministically.
 */
export type DiffLine = { kind: 'add' | 'del' | 'ctx'; text: string; newLine?: number; oldLine?: number };
export interface Hunk {
  header: string;
  lines: DiffLine[];
}
export interface ParsedPatch {
  hunks: Hunk[];
  addedLines: Set<number>;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parsePatch(patch: string): ParsedPatch {
  const hunks: Hunk[] = [];
  const addedLines = new Set<number>();
  let cur: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const m = raw.match(HUNK_RE);
    if (m) {
      cur = { header: raw, lines: [] };
      hunks.push(cur);
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      continue;
    }
    if (!cur || raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const tag = raw[0];
    const text = raw.slice(1);
    if (tag === '+') {
      cur.lines.push({ kind: 'add', text, newLine: newNo });
      addedLines.add(newNo++);
    } else if (tag === '-') {
      cur.lines.push({ kind: 'del', text, oldLine: oldNo++ });
    } else {
      cur.lines.push({ kind: 'ctx', text, newLine: newNo++, oldLine: oldNo++ });
    }
  }
  return { hunks, addedLines };
}

export function renderHunk(h: Hunk): string {
  const out = [h.header];
  for (const l of h.lines) {
    if (l.kind === 'add') out.push(`+${String(l.newLine).padStart(5)} | ${l.text}`);
    else if (l.kind === 'ctx') out.push(` ${String(l.newLine).padStart(5)} | ${l.text}`);
    else out.push(`-${''.padStart(5)} | ${l.text}`);
  }
  return out.join('\n');
}

/** Splits a file's hunks into chunks whose rendered size fits the token budget. Oversized hunks are split by lines. */
export function chunkHunks(hunks: Hunk[], maxTokens: number, estimate: (s: string) => number): Hunk[][] {
  const pieces: Hunk[] = [];
  for (const h of hunks) {
    if (estimate(renderHunk(h)) <= maxTokens) {
      pieces.push(h);
      continue;
    }
    let part: DiffLine[] = [];
    for (const l of h.lines) {
      part.push(l);
      if (estimate(renderHunk({ header: h.header, lines: part })) > maxTokens) {
        part.pop();
        if (part.length) pieces.push({ header: h.header + ' (split)', lines: part });
        part = [l];
      }
    }
    if (part.length) pieces.push({ header: h.header + ' (split)', lines: part });
  }
  const chunks: Hunk[][] = [];
  let cur: Hunk[] = [];
  let size = 0;
  for (const p of pieces) {
    const s = estimate(renderHunk(p));
    if (cur.length && size + s > maxTokens) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Widens each hunk to its enclosing top-level block (function, class, component, statement) using the
 * file at the PR's head commit, so the Reviewer sees the whole function rather than 3 lines of context.
 * Heuristic and language-agnostic: walk up to the nearest unindented line that opens a statement, and
 * down to the unindented line that closes it, never more than `radius` lines each way.
 * Overlapping or adjacent expansions are merged into one hunk. Added/removed lines are untouched.
 */
export function expandHunks(hunks: Hunk[], fileLines: string[], radius: number): Hunk[] {
  if (!radius || !fileLines.length) return hunks;
  const lineAt = (n: number) => fileLines[n - 1] ?? '';
  const isTop = (s: string) => s.length > 0 && !/^\s/.test(s);
  const isCloser = (s: string) => /^[}\])]/.test(s);

  const ranges = hunks.map((h) => {
    const nums = h.lines.filter((l) => l.newLine != null).map((l) => l.newLine!);
    const first = nums.length ? Math.min(...nums) : 1;
    const last = nums.length ? Math.max(...nums) : first;
    let start = first;
    for (let n = first - 1; n >= Math.max(1, first - radius); n--) {
      start = n;
      if (isTop(lineAt(n)) && !isCloser(lineAt(n))) break;
    }
    let end = last;
    for (let n = last + 1; n <= Math.min(fileLines.length, last + radius); n++) {
      if (isTop(lineAt(n)) && !isCloser(lineAt(n))) break; // next statement starts: stop before it
      end = n;
      if (isTop(lineAt(n)) && isCloser(lineAt(n))) break; // closing brace of the block: include it
    }
    return { h, first, last, start, end };
  });

  const out: Hunk[] = [];
  const ctx = (from: number, to: number): DiffLine[] =>
    Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => ({ kind: 'ctx' as const, text: lineAt(from + i), newLine: from + i }));

  let i = 0;
  while (i < ranges.length) {
    const group = [ranges[i]];
    while (i + 1 < ranges.length && ranges[i + 1].start <= group[group.length - 1].end + 1) group.push(ranges[++i]);
    i++;
    const lines: DiffLine[] = [...ctx(group[0].start, group[0].first - 1)];
    group.forEach((g, k) => {
      if (k > 0) lines.push(...ctx(group[k - 1].last + 1, g.first - 1));
      lines.push(...g.h.lines);
    });
    const tail = group[group.length - 1];
    lines.push(...ctx(tail.last + 1, Math.max(...group.map((g) => g.end))));
    out.push({ header: group.map((g) => g.h.header).join(' + ') + ' (with enclosing code)', lines });
  }
  return out;
}

/** A few lines around `line` from the patch, with the target marked ">>". Used by the Verifier. */
export function excerpt(parsed: ParsedPatch, line: number, radius = 3): string {
  for (const h of parsed.hunks) {
    const idx = h.lines.findIndex((l) => l.newLine === line && l.kind === 'add');
    if (idx === -1) continue;
    return h.lines
      .slice(Math.max(0, idx - radius * 2), idx + radius + 1)
      .filter((l) => l.kind !== 'del' || Math.abs(h.lines.indexOf(l) - idx) <= radius)
      .map((l) => `${l.newLine === line && l.kind === 'add' ? '>>' : '  '}${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '} ${l.text}`)
      .join('\n');
  }
  return '';
}
