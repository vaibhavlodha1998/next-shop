import type { Octokit } from '@octokit/rest';
import { responderAgent } from '../mastra/agents/responder';
import { INPUT_TOKEN_BUDGET, estimateTokens } from '../mastra/models';
import { marker } from '../lib/markers';
import { redactPii } from '../lib/policy';
import type { RepoRef } from '../lib/github';
import type { FindingMarker } from './render';
import { truncate } from './render';
import { inputGuardrails } from '../mastra/guardrails';
import { StepControl } from '../mastra/steps';
import { ToolMeter, createReviewTools, type ToolEnv } from '../mastra/tools';

/** "Ask the bot": answers why? / show an example replies in a review thread, using the cited rule. */
export async function answerInThread(o: Octokit, r: RepoRef, args: {
  pr: number;
  parentId: number;
  questionId: number;
  parentDiffHunk: string;
  finding: FindingMarker;
  question: string;
  asker: string;
  /** Tool mode: read-only repo tools so the answer can point at the project's real helpers. */
  tools?: { env: ToolEnv; maxToolSteps: number; maxToolOutputChars: number } | null;
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

  const settings = { temperature: 0.3, maxOutputTokens: 700 };
  const res = args.tools
    ? await responderAgent.generate(prompt, {
        modelSettings: settings,
        toolsets: { review: createReviewTools(args.tools.env, new ToolMeter(args.tools.maxToolOutputChars)) },
        activeTools: ['read_file', 'find_usages'],
        maxSteps: args.tools.maxToolSteps + 1,
        inputProcessors: [...inputGuardrails(), new StepControl(args.tools.maxToolSteps)],
      } as any)
    : await responderAgent.generate(prompt, { modelSettings: settings });
  if (res.tripwire) throw new Error(`guardrail stopped the call: ${res.tripwire.reason}`);
  const body = `🤖 ${res.text.trim()}\n\n<sub>Answered by the Responder agent from rule \`${args.finding.ruleId}\`. A human reviewer has the final say.</sub>\n${marker('reply', { ruleId: args.finding.ruleId })}`;
  const { data } = await o.pulls.createReplyForReviewComment({ ...r, pull_number: args.pr, comment_id: args.parentId, body });
  return data.html_url;
}
