/**
 * Weekly digest for rule maintainers (scheduled workflow).
 * Aggregates the last 7 days of AI review comments per rule: posted, 👍, 👎,
 * /ai dismiss and /ai wrong-rule. Maintainers then fix rule files through a normal PR.
 */
import { gh, repoRef } from '../lib/github';
import { readMarker } from '../lib/markers';
import { labels } from '../pipeline/deliver';
import type { FindingMarker } from '../pipeline/render';

async function main() {
  const o = gh();
  const r = repoRef();
  const days = Number(process.env.DIGEST_DAYS || 7);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const comments = await o.paginate(o.pulls.listReviewCommentsForRepo, { ...r, since, sort: 'created', direction: 'desc', per_page: 100 });

  type Stat = { posted: number; up: number; down: number; dismissed: number; wrongRule: number; text: string; examples: string[] };
  const stats = new Map<string, Stat>();
  const byId = new Map<number, FindingMarker>();
  const stat = (f: FindingMarker) => {
    if (!stats.has(f.ruleId)) stats.set(f.ruleId, { posted: 0, up: 0, down: 0, dismissed: 0, wrongRule: 0, text: f.ruleText, examples: [] });
    return stats.get(f.ruleId)!;
  };

  for (const c of comments) {
    const f = readMarker<FindingMarker>(c.body, 'finding');
    if (!f || new Date(c.created_at) < new Date(since)) continue;
    byId.set(c.id, f);
    const s = stat(f);
    s.posted++;
    s.up += c.reactions?.['+1'] ?? 0;
    s.down += c.reactions?.['-1'] ?? 0;
  }
  for (const c of comments) {
    const parent = c.in_reply_to_id ? byId.get(c.in_reply_to_id) : undefined;
    const m = c.body.trim().match(/^\/ai\s+(dismiss|wrong-rule)\b/i);
    if (!parent || !m) continue;
    const s = stat(parent);
    if (m[1].toLowerCase() === 'dismiss') s.dismissed++;
    else s.wrongRule++;
    if (s.examples.length < 3) s.examples.push(c.html_url);
  }

  if (!stats.size) {
    console.log(`No AI review comments in the last ${days} days.`);
    return;
  }
  const rows = [...stats.entries()].sort((a, b) => b[1].dismissed + b[1].wrongRule + b[1].down - (a[1].dismissed + a[1].wrongRule + a[1].down));
  const body = [
    `AI review activity for the last ${days} days, by rule. Rules at the top get the most pushback: consider rewording or scoping them in the rule file.`,
    '',
    '| Rule | Posted | 👍 | 👎 | Dismissed | Wrong rule | Examples |',
    '|---|---:|---:|---:|---:|---:|---|',
    ...rows.map(([id, s]) => `| \`${id}\` | ${s.posted} | ${s.up} | ${s.down} | ${s.dismissed} | ${s.wrongRule} | ${s.examples.map((u, i) => `[${i + 1}](${u})`).join(' ')} |`),
    '',
    '<details><summary>Rule texts</summary>',
    '',
    ...rows.map(([id, s]) => `- \`${id}\`: ${s.text}`),
    '',
    '</details>',
  ].join('\n');
  const names = await labels(o, r, 'base', 'digest');
  const { data } = await o.issues.create({ ...r, title: `AI review weekly digest (${new Date().toISOString().slice(0, 10)})`, body, labels: names.filter((n) => n !== 'ai-review') });
  console.log(`Digest: ${data.html_url}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
