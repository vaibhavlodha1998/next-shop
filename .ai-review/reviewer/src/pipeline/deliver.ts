import type { Octokit } from '@octokit/rest';
import type { Finding } from '../mastra/schemas';
import type { SecretHit } from '../lib/policy';
import { ensureLabel, setStatus, runUrl, type RepoRef } from '../lib/github';
import { marker, readMarker } from '../lib/markers';
import { commentBody, truncate } from './render';

/**
 * Steps 08 and 09: shadow drafts, security escalation and publishing.
 * The drafts issue is the approval queue: it holds the exact findings and the commit
 * they were made for. Approval is tied to that commit, so a new push voids it.
 */
export interface IssueState {
  v: 1;
  kind: 'drafts' | 'secret';
  pr: number;
  sha: string;
  baseSha: string;
  requiresSecurity: boolean;
  findings: Finding[];
  summary: string;
  secrets?: SecretHit[];
  createdAt: string;
}

export const LABELS = {
  base: ['ai-review', '5319e7', 'Created by the AI PR reviewer'],
  drafts: ['ai-review:drafts', 'fbca04', 'AI review drafts waiting for /approve or /reject'],
  security: ['ai-review:security-escalation', 'd93f0b', 'Needs security approval'],
  approved: ['ai-review:approved', '0e8a16', ''],
  rejected: ['ai-review:rejected', 'b60205', ''],
  voided: ['ai-review:voided', 'cccccc', 'Superseded by a newer commit'],
  dismissed: ['ai-feedback:dismissed', 'c5def5', 'An AI comment was dismissed'],
  wrongRule: ['ai-feedback:wrong-rule', 'c5def5', 'An AI comment cited the wrong rule'],
  digest: ['ai-review:digest', '5319e7', 'Weekly AI review digest'],
} as const;

export async function labels(o: Octokit, r: RepoRef, ...keys: (keyof typeof LABELS)[]) {
  for (const k of keys) await ensureLabel(o, r, ...(LABELS[k] as unknown as [string, string, string]));
  return keys.map((k) => LABELS[k][0]);
}

/** Closes open drafts/escalation issues for this PR made for an older commit. */
export async function voidStale(o: Octokit, r: RepoRef, pr: number, currentSha: string) {
  const open = await o.paginate(o.issues.listForRepo, { ...r, labels: LABELS.base[0], state: 'open', per_page: 100 });
  for (const issue of open) {
    const st = readMarker<IssueState>(issue.body, 'state');
    if (!st || st.pr !== pr || st.sha === currentSha) continue;
    await labels(o, r, 'voided');
    await o.issues.createComment({ ...r, issue_number: issue.number, body: `Voided: PR #${pr} has a newer commit (\`${currentSha.slice(0, 7)}\`). Approval is tied to the exact commit.` });
    await o.issues.addLabels({ ...r, issue_number: issue.number, labels: [LABELS.voided[0]] });
    await o.issues.update({ ...r, issue_number: issue.number, state: 'closed', state_reason: 'not_planned' });
  }
}

const mention = (users: string[]) => users.map((u) => '@' + u.replace(/^@/, '')).join(' ');

export async function createDraftsIssue(o: Octokit, r: RepoRef, st: IssueState, approvers: string[]) {
  const names = await labels(o, r, 'base', 'drafts', ...(st.requiresSecurity ? (['security'] as const) : []));
  const link = (f: Finding) => `https://github.com/${r.owner}/${r.repo}/blob/${st.sha}/${f.path}#L${f.line}`;
  const body = [
    `AI review drafts for PR #${st.pr} at commit \`${st.sha.slice(0, 7)}\`. **Nothing has been posted to the PR yet.**`,
    st.requiresSecurity ? '\n> ⚠️ **Security escalation:** at least one critical security finding. Only security approvers can approve.\n' : '',
    `Approvers: ${approvers.length ? mention(approvers) : 'anyone with write access'}`,
    '',
    'Reply **`/approve`** to publish these comments on the PR, or **`/reject`** to discard them.',
    'A new push to the PR voids this issue.',
    '',
    '---',
    ...st.findings.flatMap((f, i) => [
      `#### ${i + 1}. ${f.title}`,
      `\`${f.ruleId}\` · ${f.severity} · ${f.category} · [${f.path}:${f.line}](${link(f)})`,
      '',
      f.message,
      ...(f.suggestion ? ['', '```', f.suggestion, '```'] : []),
      `<sub>Verifier: ${truncate(f.verifierReason ?? '', 200)}</sub>`,
      '',
    ]),
    marker('state', st),
  ].join('\n');

  const { data: issue } = await o.issues.create({
    ...r,
    title: `${st.requiresSecurity ? '[SECURITY] ' : ''}AI review drafts: PR #${st.pr} @ ${st.sha.slice(0, 7)} (${st.findings.length})`,
    body,
    labels: names,
  });
  if (approvers.length) await o.issues.addAssignees({ ...r, issue_number: issue.number, assignees: approvers }).catch(() => {});
  await setStatus(o, r, st.sha, 'pending', `${st.findings.length} draft comment(s) awaiting approval in #${issue.number}`, issue.html_url);
  return issue;
}

export async function escalateSecrets(o: Octokit, r: RepoRef, st: IssueState, securityApprovers: string[]) {
  const names = await labels(o, r, 'base', 'security');
  const body = [
    `🚨 **Possible secret in PR #${st.pr}** at commit \`${st.sha.slice(0, 7)}\`. The AI review **stopped before any model call**; nothing from this diff was sent to a model.`,
    '',
    `Security: ${securityApprovers.length ? mention(securityApprovers) : 'repo admins'}`,
    '',
    '| File | Line | Detector rule |',
    '|---|---|---|',
    ...(st.secrets ?? []).map((s) => `| \`${s.file}\` | ${s.line} | \`${s.rule}\` |`),
    '',
    'Secret values are never copied here. Next steps:',
    '- The author should remove the secret, rotate it, and push. The new push voids this issue and reviews again.',
    '- If it is a false positive, a security approver can reply **`/approve`**: the review then runs with the flagged files excluded.',
    '- **`/reject`** closes this without a review.',
    marker('state', st),
  ].join('\n');
  const { data: issue } = await o.issues.create({ ...r, title: `[SECURITY] Possible secret in PR #${st.pr} @ ${st.sha.slice(0, 7)}`, body, labels: names });
  if (securityApprovers.length) await o.issues.addAssignees({ ...r, issue_number: issue.number, assignees: securityApprovers }).catch(() => {});
  await setStatus(o, r, st.sha, 'failure', `Possible secret in diff. Review stopped, security notified (#${issue.number})`, issue.html_url);
  return issue;
}

/** Step 09: posts one PR review with inline comments, each citing its rule. */
export async function publishReview(o: Octokit, r: RepoRef, pr: number, sha: string, findings: Finding[], summary: string) {
  const comments = findings.map((f) => ({ path: f.path, line: f.line, side: 'RIGHT' as const, body: commentBody(f, sha) }));
  let url: string;
  try {
    const { data } = await o.pulls.createReview({ ...r, pull_number: pr, commit_id: sha, event: 'COMMENT', body: summary, comments });
    url = data.html_url;
  } catch (e: any) {
    // 422 usually means a line is no longer in the diff. Fall back to one summary comment so nothing is lost.
    if (e.status !== 422) throw e;
    const list = findings.map((f) => `- **${f.path}:${f.line}** \`${f.ruleId}\` ${f.title}: ${f.message}`).join('\n');
    const { data } = await o.issues.createComment({ ...r, issue_number: pr, body: `${summary}\n\n${list}\n\n<sub>Inline comments failed (${truncate(e.message, 120)}), so findings are listed here.</sub>` });
    url = data.html_url;
  }
  await setStatus(o, r, sha, 'success', findings.length ? `Published ${findings.length} AI review comment(s)` : 'No AI review findings', runUrl() ?? url);
  return url;
}
