import { chunkHunks, expandHunks, type Hunk } from '../lib/diff';
import { moduleFor, type ProjectContext } from '../analyze/context';
import type { ReviewableFile } from '../lib/policy';
import { renderRule, rulesForFile, type Rule } from '../lib/rules';
import { skillsForFile, type Skill } from '../lib/skills';
import type { ReviewConfig } from '../lib/config';
import { INPUT_TOKEN_BUDGET, estimateTokens } from '../mastra/models';
import { REVIEWER_INSTRUCTIONS } from '../mastra/agents/reviewer';

/**
 * Step 05, Plan. Deterministic: decides per file which rules and skills apply,
 * splits the diff into chunks that fit the per-request token cap, and fits the
 * whole run into the model-call budget.
 */
export interface ReviewTask {
  file: ReviewableFile;
  rules: Rule[];
  rulesText: string;
  skills: Skill[];
  skillsText: string;
  contextText: string;
  /** Tool mode: skill folders offered in the on-demand catalog (review-core stays inline). */
  skillPaths: string[];
  chunks: Hunk[][];
  /** How far hunks were widened to enclosing code (0 = plain diff). */
  expandedRadius: number;
}

const RULES_BUDGET = 1600;
const SKILLS_BUDGET = 900;
const OVERVIEW_BUDGET = 300;
const MODULE_BUDGET = 600;
/** Widening steps tried in order: the widest view that needs no extra model calls wins. */
const RADII = [60, 30, 15, 0];
const SCHEMA_AND_WRAPPER = 700; // response_format schema + prompt scaffolding
/** Model calls held back for the Verifier. */
export const VERIFIER_RESERVE = 2;

export function plan(
  files: ReviewableFile[],
  allRules: Rule[],
  allSkills: Skill[],
  cfg: ReviewConfig,
  ctx: ProjectContext | null = null,
  fileLines: Map<string, string[]> = new Map(),
) {
  const tasks: ReviewTask[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const notes: string[] = [];
  let callsLeft = cfg.limits.maxModelCalls - VERIFIER_RESERVE;

  // Largest changes first, so the file cap drops the smallest files.
  const ordered = [...files].sort((a, b) => b.parsed.addedLines.size - a.parsed.addedLines.size);

  for (const [i, file] of ordered.entries()) {
    if (i >= cfg.limits.maxFiles) {
      skipped.push({ path: file.path, reason: `over the ${cfg.limits.maxFiles}-file limit` });
      continue;
    }
    const rules = rulesForFile(allRules, file.path);
    if (!rules.length) {
      skipped.push({ path: file.path, reason: 'no rules apply to this path' });
      continue;
    }
    const { text: rulesText, omitted } = fit(rules.map(renderRule), RULES_BUDGET);
    if (omitted) notes.push(`${file.path}: ${omitted} rules did not fit the prompt budget and were not checked`);

    const skills = skillsForFile(allSkills, file.path);
    const tools = cfg.reviewer.tools;
    // Tool mode: only review-core is inlined; the rest sit in a catalog and are loaded with the `skill` tool when needed.
    const inline = tools ? skills.filter((sk) => sk.name === 'review-core') : skills;
    const onDemand = tools ? skills.filter((sk) => sk.name !== 'review-core') : [];
    const skillsText = fitSkills(inline, SKILLS_BUDGET);
    const contextText = ctx ? renderContextFor(ctx, file.path) : '';
    // Room kept free for what tools add during the loop: tool schemas, the catalog, loaded skills and tool results.
    const toolReserve = tools
      ? 300 + 60 * onDemand.length + 350 * Math.min(2, onDemand.length) + estimateTokens('x'.repeat(cfg.reviewer.maxToolOutputChars))
      : 0;

    const fixed =
      estimateTokens(REVIEWER_INSTRUCTIONS) + estimateTokens(rulesText) + estimateTokens(skillsText) + estimateTokens(contextText) + SCHEMA_AND_WRAPPER + toolReserve;
    const diffBudget = Math.max(800, INPUT_TOKEN_BUDGET - fixed);
    const plain = chunkHunks(file.parsed.hunks, diffBudget, estimateTokens);
    let chunks = plain;
    let expandedRadius = 0;
    const lines = fileLines.get(file.path);
    if (lines) {
      for (const radius of RADII) {
        const widened = radius ? chunkHunks(expandHunks(file.parsed.hunks, lines, radius), diffBudget, estimateTokens) : plain;
        if (widened.length <= plain.length) {
          chunks = widened;
          expandedRadius = radius;
          break;
        }
      }
    }

    // Worst case per chunk: one request per tool step plus the final answer (unused calls are refunded).
    const perChunk = tools ? 1 + cfg.reviewer.maxToolSteps : 1;
    const affordable = Math.floor(callsLeft / perChunk);
    if (affordable <= 0) {
      skipped.push({ path: file.path, reason: 'model call budget for this run used up' });
      continue;
    }
    if (chunks.length > affordable) {
      notes.push(`${file.path}: only ${affordable} of ${chunks.length} diff chunks reviewed (call budget)`);
      chunks = chunks.slice(0, affordable);
    }
    callsLeft -= chunks.length * perChunk;
    tasks.push({ file, rules, rulesText, skills, skillsText, contextText, skillPaths: onDemand.map((sk) => sk.dir), chunks, expandedRadius });
  }
  return { tasks, skipped, notes };
}

/** Overview plus the module section that owns this file, each trimmed to its budget. */
function renderContextFor(ctx: ProjectContext, filePath: string): string {
  const parts: string[] = [];
  if (ctx.overview) parts.push(fit(ctx.overview.split('\n'), OVERVIEW_BUDGET).text);
  const mod = moduleFor(ctx, filePath);
  if (mod) parts.push(`Module ${mod.title}:\n${fit(mod.body.split('\n'), MODULE_BUDGET).text}`);
  return parts.join('\n\n');
}

function fit(lines: string[], budget: number): { text: string; omitted: number } {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const t = estimateTokens(l) + 1;
    if (used + t > budget) break;
    out.push(l);
    used += t;
  }
  return { text: out.join('\n'), omitted: lines.length - out.length };
}

function fitSkills(skills: Skill[], budget: number): string {
  // review-core first, then specific skills; each trimmed to its share of the budget.
  const ordered = [...skills].sort((a, b) => (a.name === 'review-core' ? -1 : b.name === 'review-core' ? 1 : 0));
  const share = Math.floor(budget / Math.max(1, ordered.length));
  return ordered
    .map((s) => {
      let body = s.body;
      while (estimateTokens(body) > share && body.length > 200) body = body.slice(0, Math.floor(body.length * 0.85));
      return `### Skill: ${s.name} (v${s.version})\n${body}${body.length < s.body.length ? '\n[...trimmed]' : ''}`;
    })
    .join('\n\n');
}
