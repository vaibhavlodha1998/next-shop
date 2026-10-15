import fs from 'node:fs';
import path from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { HIDDEN_LINE, redactPii, scanLines } from '../lib/policy';

/**
 * Read-only tools for the agents. They can only READ the repository:
 *   - files changed in the PR come from the PR's head commit (already fetched),
 *   - every other file comes from the checkout on disk (the PR's base commit).
 * Every result passes the same policy as the diff: excluded paths are refused, test files are
 * PII-redacted, and any line the secret scan flags is replaced before the model sees it.
 * A per-chunk character meter keeps each request under the provider's token cap.
 */
export interface ToolEnv {
  root: string;
  headFiles: Map<string, string[]>;
  isBlocked: (p: string) => boolean;
  isPii: (p: string) => boolean;
  /** Code files to search, lazily listed and cached. */
  codeFiles: () => string[];
}

export interface ToolCallLog {
  tool: string;
  args: Record<string, unknown>;
  chars: number;
  note?: string;
}

export class ToolMeter {
  used = 0;
  calls: ToolCallLog[] = [];
  constructor(readonly max: number) {}
  remaining() {
    return this.max - this.used;
  }
}

const MAX_LINES = 150;
const MAX_HITS = 20;
const EXHAUSTED = 'Tool output budget for this file is used up. Finish the review with what you have.';

export function createReviewTools(env: ToolEnv, meter: ToolMeter) {
  const load = (rel: string): string[] | null => {
    const head = env.headFiles.get(rel);
    if (head) return head;
    const abs = path.join(env.root, rel);
    if (!abs.startsWith(env.root + path.sep) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory() || fs.statSync(abs).size > 400_000) return null;
    const text = fs.readFileSync(abs, 'utf8');
    return (env.isPii(rel) ? redactPii(text).text : text).split('\n');
  };

  /** Secret-scan the lines we are about to return and blank any hit. */
  const scrub = (rel: string, numbered: [number, string][]): [number, string][] => {
    const { hits } = scanLines(new Map([[rel, new Map(numbered)]]));
    const bad = new Set(hits.map((h) => h.line));
    return numbered.map(([n, t]) => [n, bad.has(n) ? HIDDEN_LINE : t]);
  };

  const charge = (tool: string, args: Record<string, unknown>, text: string, note?: string) => {
    const out = text.length > meter.remaining() ? text.slice(0, Math.max(0, meter.remaining())) + '\n[...truncated: tool budget]' : text;
    meter.used += out.length;
    meter.calls.push({ tool, args, chars: out.length, note });
    return out;
  };

  const read_file = createTool({
    id: 'read_file',
    description:
      'Read a file from the repository at this PR (read-only). Use it to check code the diff calls or depends on, for example a helper, a type or a config. ' +
      `Returns at most ${MAX_LINES} numbered lines; pass startLine/endLine for a window of a long file.`,
    inputSchema: z.object({
      path: z.string().describe('Path from the repository root, e.g. src/lib/auth.ts'),
      startLine: z.number().nullable().describe('First line to return, or null for the start'),
      endLine: z.number().nullable().describe('Last line to return, or null'),
    }),
    execute: async ({ path: p, startLine, endLine }) => {
      if (meter.remaining() < 200) return { error: EXHAUSTED };
      const rel = normalise(p);
      if (!rel || env.isBlocked(rel)) {
        meter.calls.push({ tool: 'read_file', args: { path: p }, chars: 0, note: 'refused by policy' });
        return { error: `"${p}" is excluded by the review policy (env files, secrets, vendored or generated code, lockfiles).` };
      }
      const lines = load(rel);
      if (!lines) {
        meter.calls.push({ tool: 'read_file', args: { path: p }, chars: 0, note: 'not found' });
        return { error: `File not found: ${rel}` };
      }
      const from = Math.max(1, Math.trunc(startLine ?? 1));
      const to = Math.min(lines.length, Math.trunc(endLine ?? from + MAX_LINES - 1), from + MAX_LINES - 1);
      const window = scrub(rel, lines.slice(from - 1, to).map((t, i) => [from + i, t]));
      const text = window.map(([n, t]) => `${String(n).padStart(5)} | ${t}`).join('\n');
      const more = to < lines.length ? `\n[file has ${lines.length} lines; call again with startLine=${to + 1} for more]` : '';
      return { path: rel, lines: `${from}-${to}`, content: charge('read_file', { path: rel, startLine: from, endLine: to }, text + more) };
    },
  });

  const find_usages = createTool({
    id: 'find_usages',
    description:
      'Find where a function, component, type or variable is used across the repository (whole-word match, read-only). ' +
      'Use it to see whether a change breaks callers or skips a pattern used everywhere else.',
    inputSchema: z.object({ symbol: z.string().describe('An identifier, e.g. getSession or AddToCartButton') }),
    execute: async ({ symbol }) => {
      if (meter.remaining() < 200) return { error: EXHAUSTED };
      if (!/^[A-Za-z_$][\w$]{1,60}$/.test(symbol)) return { error: 'Pass a single identifier.' };
      const re = new RegExp(`(^|[^\\w$])${symbol.replace(/\$/g, '\\$')}([^\\w$]|$)`);
      const hits: string[] = [];
      let total = 0;
      for (const rel of env.codeFiles()) {
        const lines = load(rel);
        if (!lines) continue;
        const found: [number, string][] = [];
        lines.forEach((t, i) => re.test(t) && found.push([i + 1, t.trim().slice(0, 160)]));
        total += found.length;
        for (const [n, t] of scrub(rel, found)) if (hits.length < MAX_HITS) hits.push(`${rel}:${n}: ${t}`);
      }
      const text = hits.join('\n') + (total > hits.length ? `\n[${total - hits.length} more matches not shown]` : '');
      return { symbol, matches: total, hits: charge('find_usages', { symbol }, text || '(no matches)') };
    },
  });

  return { read_file, find_usages };
}

function normalise(p: string): string | null {
  const rel = path.posix.normalize(p.replace(/\\/g, '/').replace(/^\.?\//, ''));
  if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel)) return null;
  return rel;
}
