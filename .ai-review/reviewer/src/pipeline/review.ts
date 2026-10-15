import { RequestContext } from '@mastra/core/request-context';
import { reviewerAgent } from '../mastra/agents/reviewer';
import { reviewerOutput, type ReviewerFinding } from '../mastra/schemas';
import { OUTPUT_TOKEN_LIMIT } from '../mastra/models';
import { generateStructured } from '../mastra/structured';
import { inputGuardrails } from '../mastra/guardrails';
import { StepControl } from '../mastra/steps';
import { ToolMeter, createReviewTools, type ToolEnv } from '../mastra/tools';
import { renderHunk, type Hunk } from '../lib/diff';
import type { CallBudget } from '../lib/limiter';
import type { ReviewConfig } from '../lib/config';
import type { ReviewTask } from './plan';

/**
 * Step 06, model call 1: the Reviewer, once per diff chunk, in parallel within the rate limits.
 *
 * Tool mode (default): an agent loop. The Reviewer may load a skill from its catalog and call the
 * read-only tools (read_file, find_usages) for up to `maxToolSteps` steps, then must answer with
 * typed findings. Single-call mode: one request with the skills inlined.
 */
export interface RawFinding extends ReviewerFinding {
  path: string;
}

export interface AgentTrace {
  path: string;
  chunk: number;
  steps: number;
  forcedAnswer: boolean;
  skillsLoaded: string[];
  toolCalls: { tool: string; args: Record<string, unknown>; chars: number; note?: string }[];
}

export async function reviewAll(tasks: ReviewTask[], budget: CallBudget, cfg: ReviewConfig, toolEnv: ToolEnv | null) {
  const errors: { path: string; error: string }[] = [];
  const traces: AgentTrace[] = [];
  const tools = cfg.reviewer.tools && toolEnv != null;
  const perChunk = tools ? 1 + cfg.reviewer.maxToolSteps : 1;
  const jobs = tasks.flatMap((t) => t.chunks.map((c, i) => ({ t, c, i })));

  const results = await Promise.all(
    jobs.map(({ t, c, i }) =>
      budget
        .run(async () => {
          if (!budget.reserve(perChunk)) return [] as RawFinding[];
          const { findings, trace } = await reviewChunk(t, c, i, cfg, tools ? toolEnv : null);
          budget.refund(perChunk - Math.max(1, trace.steps));
          traces.push(trace);
          return findings;
        })
        .catch((e: Error) => {
          errors.push({ path: t.file.path, error: e.message });
          return [] as RawFinding[];
        }),
    ),
  );
  return { findings: results.flat(), errors, traces };
}

async function reviewChunk(task: ReviewTask, chunk: Hunk[], index: number, cfg: ReviewConfig, toolEnv: ToolEnv | null) {
  const total = task.chunks.length;
  const prompt = [
    `FILE: ${task.file.path}${total > 1 ? `  (diff part ${index + 1} of ${total})` : ''}`,
    '',
    ...(task.contextText ? ['PROJECT CONTEXT (how this codebase works; use it to judge the change, but cite only RULES):', task.contextText, ''] : []),
    'RULES (cite exactly one id per finding):',
    task.rulesText,
    '',
    'SKILLS (how to review this kind of file):',
    task.skillsText || '(none)',
    ...(toolEnv && task.skillPaths.length ? ['More checklists for this file are in the skills catalog: load the matching one with the skill tool.'] : []),
    '',
    'DIFF. Lines starting "+" are added; the number is the new-file line number. Lines starting "-" were removed.',
    ...(task.expandedRadius ? ['Unmarked lines are unchanged code around the change (the enclosing function or block), shown for context only.'] : []),
    '<diff>',
    chunk.map(renderHunk).join('\n'),
    '</diff>',
    '',
    'Return only findings for added lines that break a listed rule. An empty list is a good answer when nothing breaks a rule.',
  ].join('\n');

  const trace: AgentTrace = { path: task.file.path, chunk: index + 1, steps: 1, forcedAnswer: false, skillsLoaded: [], toolCalls: [] };
  const settings = { temperature: 0.1, maxOutputTokens: OUTPUT_TOKEN_LIMIT };
  let out;

  if (!toolEnv) {
    out = await generateStructured(reviewerAgent, prompt, reviewerOutput, settings);
  } else {
    const meter = new ToolMeter(cfg.reviewer.maxToolOutputChars);
    const control = new StepControl(cfg.reviewer.maxToolSteps);
    const requestContext = new RequestContext();
    requestContext.set('skillPaths', task.skillPaths);
    out = await generateStructured(reviewerAgent, prompt, reviewerOutput, settings, {
      requestContext,
      toolsets: { review: createReviewTools(toolEnv, meter) },
      activeTools: ['read_file', 'find_usages', ...(task.skillPaths.length ? ['skill'] : [])],
      maxSteps: cfg.reviewer.maxToolSteps + 1,
      inputProcessors: [...inputGuardrails(), control],
      onStepFinish: (step: any) => {
        for (const call of step.toolCalls ?? []) {
          const name = call.payload?.toolName ?? call.toolName;
          const args = call.payload?.args ?? call.args ?? {};
          if (name === 'skill' && args.name) trace.skillsLoaded.push(String(args.name));
        }
      },
    });
    trace.steps = control.steps;
    trace.forcedAnswer = control.forced;
    trace.toolCalls = meter.calls;
  }

  const findings = out.findings.map((f) => ({
    ...f,
    path: task.file.path,
    line: Math.trunc(Number(f.line)),
    confidence: Math.min(1, Math.max(0, Number(f.confidence) || 0)),
  }));
  return { findings, trace };
}
