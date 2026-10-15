import type { Octokit } from '@octokit/rest';
import { responderAgent } from '../mastra/agents/responder';
import { INPUT_TOKEN_BUDGET, estimateTokens } from '../mastra/models';
import { marker } from '../lib/markers';
import { redactPii } from '../lib/policy';
import type { RepoRef } from '../lib/github';
import type { FindingMarker } from './render';
import { truncate } from './render';

/** "Ask the bot": answers why? / show an example replies in a review thread, using the cited rule. */
export async function answerInThread(o: Octokit, r: RepoRef, args: {
  pr: number;
  parentId: number;
  questionId: number;
  parentDiffHunk: string;
  finding: FindingMarker;
  question: string;
  asker: string;
}) {
  const thread = (await o.paginate(o.pulls.listReviewComments, { ...r, pull_number: args.pr, per_page: 100 }))
    .filter((c) => c.in_reply_to_id === args.parentId && c.id !== args.questionId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-6)
    .map((c) => `${c.user?.login ?? 'someone'}: ${truncate(c.body.replace(/<!--[\s\S]*?-->/g, ''), 500)}`);

  let hunk = redactPii(args.parentDiffHunk).text;
  while (estimateTokens(hunk) > INPUT_TOKEN_BUDGET * 0.45) hunk = hunk.split('\n').slice(Math.floor(hunk.split('\n').length / 4)).join('\n');

  const prompt = [
    `RULE [${args.finding.ruleId}] (${args.finding.ruleSource}): ${args.finding.ruleText}`,
    '',
    `REVIEW COMMENT on ${args.finding.path}:${args.finding.line} (${args.finding.severity}): ${args.finding.title}. ${args.finding.message}`,
    '',
    '<code>',
    hunk,
    '</code>',
    '',
    '<thread>',
    ...thread,
    '</thread>',
    '',
    `QUESTION from @${args.asker}: ${truncate(args.question, 800)}`,
  ].join('\n');

  const res = await responderAgent.generate(prompt, { modelSettings: { temperature: 0.3, maxOutputTokens: 700 } });
  if (res.tripwire) throw new Error(`guardrail stopped the call: ${res.tripwire.reason}`);
  const body = `🤖 ${res.text.trim()}\n\n<sub>Answered by the Responder agent from rule \`${args.finding.ruleId}\`. A human reviewer has the final say.</sub>\n${marker('reply', { ruleId: args.finding.ruleId })}`;
  const { data } = await o.pulls.createReplyForReviewComment({ ...r, pull_number: args.pr, comment_id: args.parentId, body });
  return data.html_url;
}
