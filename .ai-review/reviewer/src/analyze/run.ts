import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { CONFIG_PATH, parseConfig } from '../lib/config';
import { loadRules } from '../lib/rules';
import { redactPii, scanLines } from '../lib/policy';
import { CallBudget } from '../lib/limiter';
import { gh, readRepoFile, repoRef, runUrl } from '../lib/github';
import { analystAgent, ruleWriterAgent } from '../mastra/agents/analyst';
import { moduleSummary, ruleProposal, type ModuleSummary, type RuleProposal } from '../mastra/schemas';
import { modelIds } from '../mastra/models';
import { generateStructured } from '../mastra/structured';
import { writeRecord } from '../pipeline/record';
import { isConfigOnly, scanProject, sampleFiles, type Module, type ScanResult } from './scan';
import { CONTEXT_PATH, normalise } from './context';

/**
 * `ai-review analyze`: learns the project once so every later review has context.
 *   1. Deterministic scan (stack, versions, layout, modules)            no model
 *   2. Sample a few representative files per module, secret-scan them   no model
 *   3. One Analyst call per module (fast model)                         model
 *   4. If the repo has no rules yet, one Rule writer call (large model)  model
 *   5. Write .ai-review/project-context.md (+ starter rules in AGENTS.md)
 *   6. Deliver as a pull request for a human to correct and merge
 */
export interface AnalyzeOptions {
  root: string;
  /** pr: open/update a PR (CI). write: write files into the repo (local). print: only print. */
  deliver: 'pr' | 'write' | 'print';
  trigger: string;
  /** Issue or PR number to reply on when triggered by a comment. */
  replyTo?: number;
}

export const ANALYZE_BRANCH = 'ai-review/analyze';
const SAMPLE_CHARS = 14_000; // about 4,400 tokens of code per module, inside the 8k request cap

export async function runAnalyze(opts: AnalyzeOptions) {
  const t0 = Date.now();
  const root = path.resolve(opts.root);
  const cfg = parseConfig(readLocal(root, CONFIG_PATH));
  const scan = scanProject(root, cfg.excludeGlobs);
  const notes: string[] = [];

  // Fit the module list into the call budget: largest modules get their own summary.
  const maxModules = Math.max(1, cfg.limits.maxAnalyzeCalls - 1);
  const ranked = scan.modules.filter((m) => !isConfigOnly(m)).sort((a, b) => b.files.length - a.files.length);
  const summarised = ranked.slice(0, maxModules).sort((a, b) => a.dir.localeCompare(b.dir));
  const unsummarised = ranked.slice(maxModules);
  if (unsummarised.length) notes.push(`${unsummarised.length} smaller module(s) listed without a summary (call budget): ${unsummarised.map((m) => m.dir).join(', ')}`);

  // Sample files, redact PII in test paths, and drop any file the secret scan flags. Nothing flagged reaches a model.
  const isPii = picomatch(cfg.piiRedactPaths, { dot: true });
  const samples = new Map<string, { path: string; text: string }[]>();
  const lineMap = new Map<string, Map<number, string>>();
  for (const m of summarised) {
    const s = sampleFiles(root, m, SAMPLE_CHARS).map((f) => (isPii(f.path) ? { ...f, text: redactPii(f.text).text } : f));
    samples.set(m.dir, s);
    for (const f of s) lineMap.set(f.path, new Map(f.text.split('\n').map((t, i) => [i + 1, t])));
  }
  const { hits, scanner } = scanLines(lineMap);
  const flagged = new Set(hits.map((h) => h.file));
  if (flagged.size) notes.push(`Not sent to the model because the secret scan flagged them: ${[...flagged].join(', ')}`);
  for (const [dir, s] of samples) samples.set(dir, s.filter((f) => !flagged.has(f.path)));

  // Module summaries (fast model, one call each)
  const budget = new CallBudget(cfg.limits.maxAnalyzeCalls, cfg.limits.concurrency, Math.min(cfg.limits.minIntervalMs, 4500));
  const factsText = renderFacts(scan);
  const summaries = new Map<string, ModuleSummary>();
  await Promise.all(
    summarised.map((m) =>
      budget
        .run(async () => {
          if (!budget.reserve()) return;
          const prompt = modulePrompt(factsText, m, samples.get(m.dir) ?? []);
          summaries.set(m.dir, await generateStructured(analystAgent, prompt, moduleSummary, { temperature: 0.1, maxOutputTokens: 1500 }));
        })
        .catch((e: Error) => notes.push(`Summary failed for ${m.dir}: ${e.message}`)),
    ),
  );

  // Starter rules, only when the repo has none yet
  const ruleTexts: Record<string, string | null> = {};
  for (const f of cfg.ruleFiles) ruleTexts[f] = readLocal(root, f);
  const existingRules = loadRules(ruleTexts).rules;
  let proposal: RuleProposal | null = null;
  if (!existingRules.length) {
    if (budget.reserve()) {
      try {
        proposal = await budget.run(() =>
          generateStructured(ruleWriterAgent, rulesPrompt(factsText, scan, summarised, summaries), ruleProposal, { temperature: 0.2, maxOutputTokens: 3000 }),
        );
      } catch (e: any) {
        notes.push(`Rule drafting failed: ${e.message}`);
      }
    } else notes.push('No model calls left to draft starter rules');
  }

  // Render
  const sha = (process.env.GITHUB_SHA || gitHead(root) || '').slice(0, 7);
  const contextMd = renderContext(scan, summarised, unsummarised, summaries, sha);
  const files: Record<string, string> = { [CONTEXT_PATH]: contextMd };
  const rulesFile = cfg.ruleFiles[0] ?? 'AGENTS.md';
  if (proposal?.rules.length) files[rulesFile] = mergeRules(readLocal(root, rulesFile), proposal);

  const record = {
    kind: 'analyze', trigger: opts.trigger, run: runUrl(), modelCalls: budget.used,
    models: { analyst: modelIds.analyst(), ruleWriter: modelIds.reviewer() }, scanner,
    modules: summarised.map((m) => ({ dir: m.dir, files: m.files.length, sampled: (samples.get(m.dir) ?? []).map((f) => f.path), summarised: summaries.has(m.dir) })),
    unsummarised: unsummarised.map((m) => m.dir), rulesDrafted: proposal?.rules.length ?? 0, existingRules: existingRules.length, notes,
  };

  // Deliver
  let outcome: string;
  let link: string | undefined;
  if (opts.deliver === 'print') {
    console.log(Object.entries(files).map(([p, c]) => `===== ${p}\n${c}`).join('\n\n'));
    outcome = 'printed';
  } else if (opts.deliver === 'write') {
    for (const [p, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), c);
    }
    outcome = `wrote ${Object.keys(files).join(', ')}`;
  } else {
    ({ outcome, link } = await openPr(files, proposal, record, opts));
  }

  writeRecord(`analyze-${Date.now()}`, { ...record, outcome, link, durationMs: Date.now() - t0 }, analyzeSummaryMd(record, outcome, link));
  return { outcome, link, files, record };
}

// ---------------- prompts ----------------

function renderFacts(scan: ScanResult): string {
  return [
    scan.frameworks.length ? `- Frameworks and libraries: ${scan.frameworks.join(', ')}` : '',
    `- Languages: ${scan.languages.slice(0, 6).map((l) => `${l.name} (${l.files})`).join(', ') || 'unknown'}`,
    scan.packageManager ? `- Package manager / build: ${scan.packageManager}` : '',
    ...scan.facts.map((f) => `- ${f}`),
    scan.lintConfigs.length ? `- Lint and format config: ${scan.lintConfigs.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function modulePrompt(facts: string, m: Module, files: { path: string; text: string }[]): string {
  const list = m.files.slice(0, 60).join('\n') + (m.files.length > 60 ? `\n... and ${m.files.length - 60} more` : '');
  return [
    'PROJECT FACTS:', facts, '',
    `MODULE: ${m.dir === '.' ? 'root files' : m.dir} (${m.files.length} code files)`,
    'ALL FILES IN THIS MODULE:', list, '',
    `<files>`,
    ...files.map((f) => `===== ${f.path}\n${f.text}`),
    `</files>`,
  ].join('\n');
}

function rulesPrompt(facts: string, scan: ScanResult, mods: Module[], sums: Map<string, ModuleSummary>): string {
  return [
    'PROJECT FACTS:', facts, '',
    scan.readme ? `README (start):\n${scan.readme.slice(0, 1500)}\n` : '',
    'MODULE SUMMARIES:',
    ...mods.map((m) => {
      const s = sums.get(m.dir);
      return s ? `- ${m.dir}: ${s.purpose} Conventions: ${s.conventions.join(' | ')}` : `- ${m.dir}: (no summary)`;
    }),
    '',
    'Propose the starter rules.',
  ].join('\n');
}

// ---------------- rendering ----------------

function renderContext(scan: ScanResult, mods: Module[], rest: Module[], sums: Map<string, ModuleSummary>, sha: string): string {
  const out = [
    '# Project context',
    '',
    `${'<!-- ai-review:generated'} ${new Date().toISOString().slice(0, 10)}${sha ? ` at ${sha}` : ''} -->`,
    'What the AI reviewer knows about this project. It reads this file from the target branch of every PR, next to the rules in AGENTS.md.',
    'Correct anything wrong and add what a new teammate should know. Rerun `/ai-review analyze` after big structural changes.',
    '',
    '## Overview',
    '',
    renderFacts(scan),
  ];
  if (rest.length) out.push(`- Other modules: ${rest.map((m) => m.dir).join(', ')}`);
  for (const m of mods) {
    const s = sums.get(m.dir);
    const globs = m.dir === '.' ? m.globs.slice(0, 12) : m.globs;
    out.push('', `## Module: ${m.dir === '.' ? 'root files' : m.dir} (applies to: ${globs.join(', ')})`, '');
    if (!s) {
      out.push(`${m.files.length} code files. No summary yet.`);
      continue;
    }
    out.push(`**Purpose:** ${s.purpose}`, '');
    if (s.keyFiles.length) out.push('**Key files**', ...s.keyFiles.slice(0, 5).map((k) => `- \`${k.path}\`: ${k.role}`), '');
    if (s.conventions.length) out.push('**Conventions**', ...s.conventions.slice(0, 6).map((c) => `- ${c}`), '');
    if (s.reviewFocus.length) out.push('**When reviewing changes here**', ...s.reviewFocus.slice(0, 6).map((c) => `- ${c}`));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Appends a drafted rules block to AGENTS.md, leaving anything already there (such as the Next.js agent block) untouched. */
export function mergeRules(existing: string | null, p: RuleProposal): string {
  const groups = new Map<string, RuleProposal['rules']>();
  for (const r of p.rules) {
    const key = `${r.section}|${r.appliesTo.join(', ')}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const block = [
    '<!-- BEGIN:ai-review-rules -->',
    '# Code review rules',
    '',
    'The AI reviewer checks every pull request against these rules and cites them by id. Drafted by `ai-review analyze`: edit, delete or add rules, then merge.',
    "A heading's `(applies to: ...)` globs limit its rules to matching files.",
    ...[...groups.entries()].flatMap(([key, rules]) => {
      const [section, scope] = key.split('|');
      return ['', `## ${section}${scope ? ` (applies to: ${scope})` : ''}`, '', ...rules.map((r) => `- [${r.id.toUpperCase()}] ${r.text.replace(/\s+/g, ' ').trim()}`)];
    }),
    '<!-- END:ai-review-rules -->',
  ].join('\n');
  const base = (existing ?? '').replace(/<!-- BEGIN:ai-review-rules -->[\s\S]*?<!-- END:ai-review-rules -->\n?/, '').trimEnd();
  return (base ? `${base}\n\n${block}` : block) + '\n';
}

// ---------------- delivery ----------------

async function openPr(files: Record<string, string>, proposal: RuleProposal | null, record: Record<string, any>, opts: AnalyzeOptions) {
  const o = gh();
  const r = repoRef();
  const { data: repo } = await o.repos.get({ ...r });
  const base = repo.default_branch;
  const { data: branch } = await o.repos.getBranch({ ...r, branch: base });

  // Skip when nothing meaningful changed against the default branch.
  const changed: string[] = [];
  for (const [p, c] of Object.entries(files)) if (normalise(await readRepoFile(o, r, p, branch.commit.sha)) !== normalise(c)) changed.push(p);
  const say = async (body: string) => {
    if (opts.replyTo) await o.issues.createComment({ ...r, issue_number: opts.replyTo, body }).catch(() => {});
  };
  if (!changed.length) {
    await say('`ai-review analyze` found nothing new: the project context on the default branch is up to date.');
    return { outcome: 'no-change', link: undefined };
  }

  const { data: tree } = await o.git.createTree({
    ...r,
    base_tree: branch.commit.commit.tree.sha,
    tree: changed.map((p) => ({ path: p, mode: '100644' as const, type: 'blob' as const, content: files[p] })),
  });
  const { data: commit } = await o.git.createCommit({
    ...r,
    message: `chore(ai-review): update project context${proposal ? ' and draft review rules' : ''}`,
    tree: tree.sha,
    parents: [branch.commit.sha],
  });
  try {
    await o.git.updateRef({ ...r, ref: `heads/${ANALYZE_BRANCH}`, sha: commit.sha, force: true });
  } catch (e: any) {
    if (e.status !== 422 && e.status !== 404) throw e;
    await o.git.createRef({ ...r, ref: `refs/heads/${ANALYZE_BRANCH}`, sha: commit.sha });
  }

  const body = prBody(changed, proposal, record, opts.trigger);
  const { data: open } = await o.pulls.list({ ...r, head: `${r.owner}:${ANALYZE_BRANCH}`, state: 'open' });
  let url: string;
  try {
    if (open.length) {
      url = (await o.pulls.update({ ...r, pull_number: open[0].number, body })).data.html_url;
    } else {
      url = (await o.pulls.create({ ...r, head: ANALYZE_BRANCH, base, title: 'AI review: project context' + (proposal ? ' and starter rules' : ''), body })).data.html_url;
    }
  } catch (e: any) {
    if (e.status !== 403) throw e;
    // Repo setting "Allow GitHub Actions to create and approve pull requests" is off. The branch is pushed; open the PR by hand.
    url = `https://github.com/${r.owner}/${r.repo}/compare/${base}...${ANALYZE_BRANCH}?expand=1`;
    await say(`\`ai-review analyze\` pushed branch \`${ANALYZE_BRANCH}\` but could not open the PR (Actions is not allowed to create PRs in this repo). Open it here: ${url}\n\nTo let it open PRs itself: Settings > Actions > General > Workflow permissions > "Allow GitHub Actions to create and approve pull requests".`);
    return { outcome: 'branch-pushed', link: url };
  }
  await say(`\`ai-review analyze\` finished: ${url}. Review and correct it before merging; the reviewer trusts what gets merged.`);
  return { outcome: open.length ? 'pr-updated' : 'pr-opened', link: url };
}

function prBody(changed: string[], p: RuleProposal | null, rec: Record<string, any>, trigger: string): string {
  const lines = [
    `Opened by \`ai-review analyze\` (${trigger}). It updates what the AI reviewer knows about this project.`,
    '',
    '**Please read and correct this before merging.** Reviews on every PR will trust what you merge here.',
    '',
    ...changed.map((c) => `- \`${c}\`${c === CONTEXT_PATH ? `: stack facts and ${rec.modules.filter((m: any) => m.summarised).length} module summaries` : `: ${p?.rules.length ?? 0} starter rules drafted from the code (only because no rules existed yet)`}`),
  ];
  if (p?.rules.length) {
    lines.push('', '<details><summary>Why each drafted rule</summary>', '', '| Rule | Applies to | Evidence |', '|---|---|---|');
    for (const r of p.rules) lines.push(`| \`${r.id}\` ${r.text.replace(/\|/g, '\\|')} | ${r.appliesTo.join(', ') || 'all files'} | ${r.why.replace(/\|/g, '\\|')} |`);
    lines.push('', '</details>');
  }
  lines.push('', `<sub>Model calls: ${rec.modelCalls}. Files sampled: ${rec.modules.reduce((n: number, m: any) => n + m.sampled.length, 0)}. Secret scanner: ${rec.scanner}.${rec.notes.length ? ` Notes: ${rec.notes.join('; ')}` : ''}</sub>`);
  return lines.join('\n');
}

function analyzeSummaryMd(rec: Record<string, any>, outcome: string, link?: string) {
  return [
    `### AI review: project analysis`,
    '',
    `**Outcome:** ${outcome}${link ? ` (${link})` : ''}`,
    `Modules summarised: ${rec.modules.filter((m: any) => m.summarised).length}/${rec.modules.length}. Starter rules drafted: ${rec.rulesDrafted}. Model calls: ${rec.modelCalls}.`,
    ...rec.notes.map((n: string) => `- ${n}`),
  ].join('\n');
}

function readLocal(root: string, p: string): string | null {
  const f = path.join(root, p);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

function gitHead(root: string): string | null {
  try {
    const head = fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    const ref = path.join(root, '.git', head.slice(5).trim());
    return fs.existsSync(ref) ? fs.readFileSync(ref, 'utf8').trim() : null;
  } catch {
    return null;
  }
}
