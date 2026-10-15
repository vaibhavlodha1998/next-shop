import type { Finding } from '../mastra/schemas';
import { marker } from '../lib/markers';

const ICON = { critical: '🔴', major: '🟠', minor: '🟡', nit: '⚪' } as const;

export interface FindingMarker {
  id: string;
  ruleId: string;
  ruleText: string;
  ruleSource: string;
  path: string;
  line: number;
  severity: string;
  category: string;
  title: string;
  message: string;
  sha: string;
}

export function commentBody(f: Finding, sha: string): string {
  const parts = [
    `${ICON[f.severity]} **${f.title}** · \`${f.ruleId}\` · ${f.severity}`,
    '',
    f.message,
  ];
  if (f.suggestion && f.suggestion.trim()) parts.push('', '```suggestion', f.suggestion.replace(/\n+$/, ''), '```');
  parts.push(
    '',
    `> **Rule ${f.ruleId}** (${f.ruleSource}): ${truncate(f.ruleText, 400)}`,
    '',
    '<sub>AI first-pass review. Reply <code>why?</code> or <code>show an example</code>, or <code>/ai dismiss</code> · <code>/ai wrong-rule</code>. React 👍 / 👎 to rate.</sub>',
    marker('finding', {
      id: f.id, ruleId: f.ruleId, ruleText: truncate(f.ruleText, 600), ruleSource: f.ruleSource, path: f.path, line: f.line,
      severity: f.severity, category: f.category, title: f.title, message: f.message, sha,
    } satisfies FindingMarker),
  );
  return parts.join('\n');
}

export function summaryBody(opts: {
  findings: Finding[];
  reviewedFiles: number;
  skipped: { path: string; reason: string }[];
  ruleCount: number;
  ruleFiles: string[];
  baseSha: string;
  skills: string[];
  notes: string[];
  via: string;
}): string {
  const counts = (['critical', 'major', 'minor', 'nit'] as const)
    .map((s) => [s, opts.findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n)
    .map(([s, n]) => `${ICON[s]} ${n} ${s}`)
    .join(' · ');
  const lines = [
    '### 🤖 AI first-pass review',
    '',
    `Checked **${opts.reviewedFiles}** file(s) against **${opts.ruleCount}** rules from ${opts.ruleFiles.map((f) => `\`${f}\``).join(', ')} at base \`${opts.baseSha.slice(0, 7)}\`.`,
    opts.findings.length ? `**${opts.findings.length}** comment(s): ${counts}` : 'No rule breaches found in the changed lines.',
    `Delivery: ${opts.via}.`,
  ];
  if (opts.skills.length) lines.push(`Skills: ${opts.skills.map((s) => `\`${s}\``).join(', ')}`);
  if (opts.skipped.length) {
    lines.push('', '<details><summary>Not reviewed (' + opts.skipped.length + ')</summary>', '');
    opts.skipped.forEach((s) => lines.push(`- \`${s.path}\`: ${s.reason}`));
    lines.push('', '</details>');
  }
  if (opts.notes.length) {
    lines.push('', '<details><summary>Notes</summary>', '');
    opts.notes.forEach((n) => lines.push(`- ${n}`));
    lines.push('', '</details>');
  }
  lines.push('', '<sub>Humans keep the final say. Comment <code>/ai-review rerun</code> to review the latest commit again.</sub>');
  return lines.join('\n');
}

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
