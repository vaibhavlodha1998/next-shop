/**
 * Entry point for the `ai-review-commands` workflow. Handles every human touchpoint:
 *
 *   drafts / security issue:   /approve   /reject
 *   PR conversation:           /ai-review rerun
 *   reply on an AI comment:    why?   show an example   /ai dismiss   /ai wrong-rule
 *
 * Agents never write to GitHub; this script does, after its own permission checks.
 */
import type { Octokit } from '@octokit/rest';
import { gh, permissionOf, readEvent, readRepoFile, repoRef, setStatus, type RepoRef } from '../lib/github';
import { CONFIG_PATH, parseConfig } from '../lib/config';
import { readMarker } from '../lib/markers';
import { LABELS, labels, publishReview, type IssueState } from '../pipeline/deliver';
import type { FindingMarker } from '../pipeline/render';
import { answerInThread } from '../pipeline/respond';
import { runReview } from '../pipeline/run';
import { writeRecord } from '../pipeline/record';
import { makeToolEnv } from '../pipeline/run';
import { redactPii } from '../lib/policy';
import picomatch from 'picomatch';

const WRITE = ['admin', 'maintain', 'write'];

async function main() {
  const { name, payload } = readEvent<any>();
  const comment = payload.comment;
  if (!comment || payload.action !== 'created') return;
  if (comment.user?.type === 'Bot' || comment.user?.login?.endsWith('[bot]')) return; // never answer ourselves

  const o = gh();
  const r = repoRef();
  const body: string = (comment.body ?? '').trim();
  const actor: string = comment.user.login;

  if (name === 'issue_comment' && payload.issue?.pull_request) {
    if (/^\/ai-review\s+rerun\b/i.test(body)) return rerun(o, r, payload.issue.number, actor, payload.issue.user?.login, comment.id);
    return;
  }
  if (name === 'issue_comment') {
    const st = readMarker<IssueState>(payload.issue?.body, 'state');
    if (!st || payload.issue.state !== 'open') return;
    if (/^\/approve\b/i.test(body)) return decide(o, r, payload.issue.number, st, actor, 'approve');
    if (/^\/reject\b/i.test(body)) return decide(o, r, payload.issue.number, st, actor, 'reject');
    return;
  }
  if (name === 'pull_request_review_comment' && comment.in_reply_to_id) {
    const { data: parent } = await o.pulls.getReviewComment({ ...r, comment_id: comment.in_reply_to_id });
    const finding = readMarker<FindingMarker>(parent.body, 'finding');
    if (!finding) return; // not a reply to one of our comments
    const pr = payload.pull_request.number;
    const fb = body.match(/^\/ai\s+(dismiss|wrong-rule)\b/i);
    if (fb) return feedback(o, r, pr, comment.id, parent.id, finding, actor, fb[1].toLowerCase() as 'dismiss' | 'wrong-rule');
    if (/\b(why|explain|example|how)\b|\?\s*$/i.test(body)) {
      const url = await answerInThread(o, r, {
        pr, parentId: parent.id, questionId: comment.id, parentDiffHunk: parent.diff_hunk, finding, question: body, asker: actor,
        tools: await responderTools(o, r, finding),
      });
      writeRecord(`respond-${comment.id}`, { kind: 'responder', pr, ruleId: finding.ruleId, asker: actor, url }, `Responder answered @${actor} on PR #${pr} (${finding.ruleId}): ${url}`);
    }
  }
}

async function rerun(o: Octokit, r: RepoRef, pr: number, actor: string, author: string | undefined, commentId: number) {
  if (actor !== author && !WRITE.includes(await permissionOf(o, r, actor))) {
    await o.issues.createComment({ ...r, issue_number: pr, body: `@${actor} only the PR author or someone with write access can rerun the AI review.` });
    return;
  }
  await o.reactions.createForIssueComment({ ...r, comment_id: commentId, content: 'rocket' }).catch(() => {});
  await runReview({ pr, trigger: `rerun by @${actor}` });
}

async function decide(o: Octokit, r: RepoRef, issue: number, st: IssueState, actor: string, verdict: 'approve' | 'reject') {
  const cfg = parseConfig(await readRepoFile(o, r, CONFIG_PATH, st.baseSha));
  const perm = await permissionOf(o, r, actor);
  const needSecurity = st.requiresSecurity;
  const allowed = needSecurity
    ? cfg.securityApprovers.length ? cfg.securityApprovers.includes(actor) : perm === 'admin'
    : cfg.approvers.length ? cfg.approvers.includes(actor) : WRITE.includes(perm);
  const say = (b: string) => o.issues.createComment({ ...r, issue_number: issue, body: b });
  const close = async (label: keyof typeof LABELS, reason: 'completed' | 'not_planned') => {
    await labels(o, r, label);
    await o.issues.addLabels({ ...r, issue_number: issue, labels: [LABELS[label][0]] });
    await o.issues.update({ ...r, issue_number: issue, state: 'closed', state_reason: reason });
  };

  if (!allowed) {
    await say(`@${actor} you are not on the ${needSecurity ? 'security approver' : 'approver'} list for this ${needSecurity ? 'escalation' : 'review'}.`);
    return;
  }

  const { data: pr } = await o.pulls.get({ ...r, pull_number: st.pr });
  if (pr.state !== 'open' || pr.head.sha !== st.sha) {
    await say(`Voided: PR #${st.pr} is ${pr.state !== 'open' ? 'no longer open' : `now at \`${pr.head.sha.slice(0, 7)}\``}. These drafts were made for \`${st.sha.slice(0, 7)}\`, and approval is tied to that exact commit.`);
    await close('voided', 'not_planned');
    return;
  }

  const rec = { kind: st.kind, verdict, actor, issue, pr: st.pr, sha: st.sha, findings: st.findings.length };
  if (verdict === 'reject') {
    await say(`Rejected by @${actor}. Nothing was posted to PR #${st.pr}.`);
    await close('rejected', 'not_planned');
    if (st.kind === 'drafts') await setStatus(o, r, st.sha, 'success', `AI review drafts rejected by ${actor}`);
    else await setStatus(o, r, st.sha, 'failure', `Secret escalation closed by ${actor} without review`);
    writeRecord(`decision-${issue}`, rec, `@${actor} rejected #${issue} (PR #${st.pr}).`);
    return;
  }

  if (st.kind === 'secret') {
    const files = [...new Set((st.secrets ?? []).map((s) => s.file))];
    await say(`Cleared by @${actor}. Reviewing PR #${st.pr} now, **excluding** ${files.map((f) => `\`${f}\``).join(', ')}.`);
    await close('approved', 'completed');
    writeRecord(`decision-${issue}`, rec, `@${actor} cleared secret escalation #${issue}; reviewing with ${files.length} file(s) excluded.`);
    await runReview({ pr: st.pr, trigger: `security clearance by @${actor}`, excludeFiles: files });
    return;
  }

  const summary = `${st.summary}\n\n<sub>Approved by @${actor} in #${issue}.</sub>`;
  const url = await publishReview(o, r, st.pr, st.sha, st.findings, summary);
  await say(`Approved by @${actor}. Published ${st.findings.length} comment(s): ${url}`);
  await close('approved', 'completed');
  writeRecord(`decision-${issue}`, { ...rec, url }, `@${actor} approved #${issue}: ${st.findings.length} comment(s) published to PR #${st.pr}.`);
}

async function feedback(o: Octokit, r: RepoRef, pr: number, replyId: number, parentId: number, f: FindingMarker, actor: string, kind: 'dismiss' | 'wrong-rule') {
  const label = kind === 'dismiss' ? 'dismissed' : 'wrongRule';
  await labels(o, r, label);
  await o.issues.addLabels({ ...r, issue_number: pr, labels: [LABELS[label][0]] });
  await o.reactions.createForPullRequestReviewComment({ ...r, comment_id: replyId, content: 'eyes' }).catch(() => {});
  await o.pulls.createReplyForReviewComment({
    ...r, pull_number: pr, comment_id: parentId,
    body: `Recorded \`${kind}\` for rule \`${f.ruleId}\`. It will show up in the weekly digest for the rule maintainers.`,
  });
  writeRecord(`feedback-${replyId}`, { kind: 'feedback', feedback: kind, pr, ruleId: f.ruleId, path: f.path, line: f.line, actor }, `@${actor} marked ${f.ruleId} on PR #${pr} as ${kind}.`);
}

/** Tool mode for the Responder: the finding's file at the commit it was made for, everything else from the default branch checkout. */
async function responderTools(o: Octokit, r: RepoRef, f: FindingMarker) {
  const cfg = parseConfig(await readRepoFile(o, r, CONFIG_PATH, f.sha).catch(() => null));
  if (!cfg.reviewer.tools) return null;
  const head = await readRepoFile(o, r, f.path, f.sha).catch(() => null);
  const isPii = picomatch(cfg.piiRedactPaths, { dot: true });
  const headFiles = new Map<string, string[]>();
  if (head != null) headFiles.set(f.path, (isPii(f.path) ? redactPii(head).text : head).split('\n'));
  return { env: makeToolEnv(cfg, headFiles), maxToolSteps: Math.min(2, cfg.reviewer.maxToolSteps), maxToolOutputChars: cfg.reviewer.maxToolOutputChars };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
