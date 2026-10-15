import picomatch from 'picomatch';

/**
 * Rules say WHAT. They are owned by the repo team and live in plain markdown
 * (AGENTS.md, CONTRIBUTING.md, ...). Every bullet is a rule.
 *
 *   ## TypeScript (applies to: src/**\/*.ts, **\/*.tsx)
 *   - [TS-001] No `any` in exported functions.
 *   - Prefer early returns.            <- no id: gets AGENTS.md:L12
 *
 * A heading's "applies to:" globs scope every rule under it (nested headings inherit).
 * Rules with no scope apply to every file.
 */
export interface Rule {
  id: string;
  text: string;
  source: string;
  line: number;
  section: string;
  scope: string[];
}

const ID_RE = /^\[([A-Za-z][A-Za-z0-9]*-\d+)\]\s*/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const SCOPE_RE = /\((?:applies to|scope|paths?):\s*([^)]+)\)/i;
const SCOPE_LINE_RE = /^\s*(?:applies to|scope|paths?):\s*(.+)$/i;

export function parseRules(markdown: string, source: string): Rule[] {
  const rules: Rule[] = [];
  const stack: { level: number; title: string; scope: string[] }[] = [];
  let inFence = false;
  let current: Rule | null = null;
  const lines = markdown.split(/\r?\n/);

  const scopeNow = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].scope.length) return stack[i].scope;
    return [];
  };

  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      current = null;
      return;
    }
    if (inFence) return;

    const h = raw.match(HEADING_RE);
    if (h) {
      current = null;
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const sm = h[2].match(SCOPE_RE);
      stack.push({ level, title: h[2].replace(SCOPE_RE, '').trim(), scope: sm ? splitGlobs(sm[1]) : [] });
      return;
    }
    const sl = raw.match(SCOPE_LINE_RE);
    if (sl && stack.length && !current) {
      stack[stack.length - 1].scope = splitGlobs(sl[1]);
      return;
    }
    const b = raw.match(BULLET_RE);
    if (b && b[1].length < 2) {
      let text = b[2].trim();
      const idm = text.match(ID_RE);
      const id = idm ? idm[1].toUpperCase() : `${source}:L${i + 1}`;
      if (idm) text = text.slice(idm[0].length);
      current = { id, text, source, line: i + 1, section: stack.map((s) => s.title).join(' > '), scope: scopeNow() };
      rules.push(current);
      return;
    }
    // Continuation lines (indented bullets or wrapped text) belong to the current rule.
    if (current && raw.trim() && /^\s+/.test(raw)) {
      current.text += ' ' + raw.trim();
    } else if (!raw.trim()) {
      current = null;
    }
  });
  return rules.filter((r) => r.text.length > 3);
}

function splitGlobs(s: string): string[] {
  return s
    .split(/[,\s]+/)
    .map((g) => g.replace(/[`'"]/g, '').trim())
    .filter(Boolean);
}

/** `files` maps rule file path to its content (null when the file does not exist on the base branch). */
export function loadRules(files: Record<string, string | null>): { rules: Rule[]; missing: string[] } {
  const rules: Rule[] = [];
  const missing: string[] = [];
  for (const [f, content] of Object.entries(files)) {
    if (content == null) {
      missing.push(f);
      continue;
    }
    rules.push(...parseRules(content, f));
  }
  // Duplicate ids: keep the first so a citation always resolves to one rule.
  const seen = new Set<string>();
  return { rules: rules.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))), missing };
}

export function rulesForFile(rules: Rule[], filePath: string): Rule[] {
  return rules.filter((r) => !r.scope.length || picomatch.isMatch(filePath, r.scope, { dot: true }));
}

export const renderRule = (r: Rule) => `- [${r.id}] ${r.text}${r.section ? `  (section: ${r.section})` : ''}`;
