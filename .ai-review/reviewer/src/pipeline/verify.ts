import { verifierAgent, VERIFIER_INSTRUCTIONS } from '../mastra/agents/verifier';
import { verifierOutput, type Finding } from '../mastra/schemas';
import { INPUT_TOKEN_BUDGET, OUTPUT_TOKEN_LIMIT, estimateTokens } from '../mastra/models';
import { generateStructured } from '../mastra/structured';
import { excerpt } from '../lib/diff';
import type { CallBudget } from '../lib/limiter';
import type { ReviewTask } from './plan';
import type { RawFinding } from './review';

/**
 * Step 07, model call 2: verify findings. Two layers:
 *   1. Deterministic contract: the rule id must exist and apply to the file, the line must be an
 *      added line, confidence must clear the bar, duplicates go. Uncited findings never reach a human.
 *   2. Verifier agent (fast model) reads each surviving finding with its rule and code and drops weak ones.
 * If the verifier call fails, its findings are dropped (fail closed).
 */
export interface Dropped {
  finding: RawFinding;
  stage: 'contract' | 'verifier';
  reason: string;
}

const RANK = { critical: 0, major: 1, minor: 2, nit: 3 } as const;

export async function verifyAll(raw: RawFinding[], tasks: ReviewTask[], budget: CallBudget, minConfidence: number, maxComments: number) {
  const byPath = new Map(tasks.map((t) => [t.file.path, t]));
  const dropped: Dropped[] = [];
  const seen = new Set<string>();
  const candidates: Finding[] = [];

  for (const f of raw) {
    const task = byPath.get(f.path);
    const rule = task?.rules.find((r) => r.id === f.ruleId.trim().toUpperCase() || r.id === f.ruleId.trim());
    const key = `${f.path}:${f.line}:${f.ruleId}`;
    if (!task || !rule) dropped.push({ finding: f, stage: 'contract', reason: `cites unknown rule "${f.ruleId}"` });
    else if (!task.file.parsed.addedLines.has(f.line)) dropped.push({ finding: f, stage: 'contract', reason: `line ${f.line} is not an added line` });
    else if (f.confidence < minConfidence) dropped.push({ finding: f, stage: 'contract', reason: `confidence ${f.confidence} below ${minConfidence}` });
    else if (seen.has(key)) dropped.push({ finding: f, stage: 'contract', reason: 'duplicate' });
    else {
      seen.add(key);
      candidates.push({ ...f, ruleId: rule.id, id: `F${candidates.length + 1}`, ruleText: rule.text, ruleSource: `${rule.source}:L${rule.line}` });
    }
  }

  const kept: Finding[] = [];
  const errors: string[] = [];
  for (const batch of batches(candidates, byPath)) {
    if (!budget.reserve()) {
      batch.forEach((f) => dropped.push({ finding: f, stage: 'verifier', reason: 'no model calls left to verify it' }));
      continue;
    }
    try {
      const verdicts = await budget.run(() => verifyBatch(batch, byPath));
      for (const f of batch) {
        const v = verdicts.get(f.id);
        if (v?.keep) kept.push({ ...f, severity: v.severity ?? f.severity, verifierReason: v.reason });
        else dropped.push({ finding: f, stage: 'verifier', reason: v?.reason ?? 'no verdict returned' });
      }
    } catch (e: any) {
      errors.push(e.message);
      batch.forEach((f) => dropped.push({ finding: f, stage: 'verifier', reason: `verifier failed: ${e.message}` }));
    }
  }

  kept.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.confidence - a.confidence);
  const capped = kept.slice(0, maxComments);
  kept.slice(maxComments).forEach((f) => dropped.push({ finding: f, stage: 'contract', reason: `over the ${maxComments}-comment limit` }));
  capped.forEach((f, i) => (f.id = `F${i + 1}`));
  return { kept: capped, dropped, errors };
}

function item(f: Finding, byPath: Map<string, ReviewTask>) {
  return JSON.stringify({
    id: f.id,
    file: f.path,
    rule: `[${f.ruleId}] ${f.ruleText}`,
    severity: f.severity,
    finding: `${f.title}: ${f.message}`,
    code: excerpt(byPath.get(f.path)!.file.parsed, f.line),
  });
}

function* batches(all: Finding[], byPath: Map<string, ReviewTask>) {
  const budget = INPUT_TOKEN_BUDGET - estimateTokens(VERIFIER_INSTRUCTIONS) - 600;
  let cur: Finding[] = [];
  let size = 0;
  for (const f of all) {
    const s = estimateTokens(item(f, byPath));
    if (cur.length && (size + s > budget || cur.length >= 15)) {
      yield cur;
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += s;
  }
  if (cur.length) yield cur;
}

async function verifyBatch(batch: Finding[], byPath: Map<string, ReviewTask>) {
  const prompt = [
    `Verify these ${batch.length} draft findings. In each "code" field, ">>" marks the line the finding points at.`,
    '<code>',
    ...batch.map((f) => item(f, byPath)),
    '</code>',
  ].join('\n');
  const out = await generateStructured(verifierAgent, prompt, verifierOutput, { temperature: 0, maxOutputTokens: OUTPUT_TOKEN_LIMIT });
  return new Map(out.verdicts.map((v) => [v.id, v]));
}
