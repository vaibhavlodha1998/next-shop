import picomatch from 'picomatch';

/**
 * .ai-review/project-context.md: what the analyzer learned about the project, reviewed by a
 * human (it arrives as a PR) and read by the Reviewer from the target branch.
 *
 *   # Project context
 *   ## Overview            <- always sent (trimmed)
 *   ## Module: src/app/api (applies to: src/app/api/**)   <- sent for files it matches
 */
export const CONTEXT_PATH = '.ai-review/project-context.md';
export const GENERATED_MARK = '<!-- ai-review:generated';

export interface ContextSection {
  title: string;
  globs: string[];
  body: string;
}
export interface ProjectContext {
  overview: string;
  modules: ContextSection[];
}

export function parseContext(md: string | null): ProjectContext | null {
  if (!md?.trim()) return null;
  const parts = md.split(/^## /m).slice(1);
  let overview = '';
  const modules: ContextSection[] = [];
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const heading = (nl === -1 ? p : p.slice(0, nl)).trim();
    const body = (nl === -1 ? '' : p.slice(nl + 1)).replace(/<!--[\s\S]*?-->/g, '').trim();
    const scope = heading.match(/\((?:applies to|scope|paths?):\s*([^)]+)\)/i);
    if (scope) {
      modules.push({
        title: heading.replace(/\(.*\)/, '').replace(/^Module:\s*/i, '').trim(),
        globs: scope[1].split(/[,\s]+/).map((g) => g.replace(/[`'"]/g, '')).filter(Boolean),
        body,
      });
    } else if (/^overview/i.test(heading)) overview = body;
    else overview += `\n\n### ${heading}\n${body}`;
  }
  return { overview: overview.trim(), modules };
}

/** The most specific module section for a file (longest matching glob prefix wins). */
export function moduleFor(ctx: ProjectContext, filePath: string): ContextSection | null {
  let best: ContextSection | null = null;
  let bestLen = -1;
  for (const m of ctx.modules) {
    if (!picomatch.isMatch(filePath, m.globs, { dot: true })) continue;
    const len = Math.max(...m.globs.map((g) => g.replace(/\*.*$/, '').length));
    if (len > bestLen) {
      best = m;
      bestLen = len;
    }
  }
  return best;
}

/** Strips the generated-at line so a re-run that learned nothing new is detected as "no change". */
export const normalise = (s: string | null) => (s ?? '').replace(/<!-- ai-review:generated[^>]*-->/g, '').trim();
