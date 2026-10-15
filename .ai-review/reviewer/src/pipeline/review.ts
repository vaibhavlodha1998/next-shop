import { reviewerAgent } from '../mastra/agents/reviewer';
import { reviewerOutput, type ReviewerFinding } from '../mastra/schemas';
import { OUTPUT_TOKEN_LIMIT } from '../mastra/models';
import { generateStructured } from '../mastra/structured';
import { renderHunk, type Hunk } from '../lib/diff';
import type { CallBudget } from '../lib/limiter';
import type { ReviewTask } from './plan';

/** Step 06, model call 1: Reviewer, once per diff chunk, in parallel within the rate limits. */
export interface RawFinding extends ReviewerFinding {
  path: string;
}

export async function reviewAll(tasks: ReviewTask[], budget: CallBudget) {
  const errors: { path: string; error: string }[] = [];
  const jobs = tasks.flatMap((t) => t.chunks.map((c, i) => ({ t, c, i })));
  const results = await Promise.all(
    jobs.map(({ t, c, i }) =>
      budget
        .run(() => (budget.reserve() ? reviewChunk(t, c, i, t.chunks.length) : Promise.resolve([])))
        .catch((e: Error) => {
          errors.push({ path: t.file.path, error: e.message });
          return [] as RawFinding[];
        }),
    ),
  );
  return { findings: results.flat(), errors };
}

async function reviewChunk(task: ReviewTask, chunk: Hunk[], index: number, total: number): Promise<RawFinding[]> {
  const prompt = [
    `FILE: ${task.file.path}${total > 1 ? `  (diff part ${index + 1} of ${total})` : ''}`,
    '',
    ...(task.contextText ? ['PROJECT CONTEXT (how this codebase works; use it to judge the change, but cite only RULES):', task.contextText, ''] : []),
    'RULES (cite exactly one id per finding):',
    task.rulesText,
    '',
    'SKILLS (how to review this kind of file):',
    task.skillsText || '(none)',
    '',
    'DIFF. Lines starting "+" are added; the number is the new-file line number. Lines starting "-" were removed.',
    ...(task.expandedRadius ? ['Unmarked lines are unchanged code around the change (the enclosing function or block), shown for context only.'] : []),
    '<diff>',
    chunk.map(renderHunk).join('\n'),
    '</diff>',
    '',
    'Return only findings for added lines that break a listed rule. An empty list is a good answer when nothing breaks a rule.',
  ].join('\n');

  const out = await generateStructured(reviewerAgent, prompt, reviewerOutput, { temperature: 0.1, maxOutputTokens: OUTPUT_TOKEN_LIMIT });
  return out.findings.map((f) => ({
    ...f,
    path: task.file.path,
    line: Math.trunc(Number(f.line)),
    confidence: Math.min(1, Math.max(0, Number(f.confidence) || 0)),
  }));
}
