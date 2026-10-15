import path from 'node:path';
import { gh, readRepoFile, repoRef, runUrl, setStatus, permissionOf } from '../lib/github';
import { CONFIG_PATH, parseConfig, reviewerRoot } from '../lib/config';
import { loadRules } from '../lib/rules';
import { loadSkills, skillsForProject } from '../lib/skills';
import { applyPolicy, redactPii, scanLines, type PrFile } from '../lib/policy';
import { CONTEXT_PATH, parseContext } from '../analyze/context';
import picomatch from 'picomatch';
import { CallBudget } from '../lib/limiter';
import { modelIds } from '../mastra/models';
import { plan } from './plan';
import { reviewAll } from './review';
import { verifyAll } from './verify';
import { summaryBody } from './render';
import { createDraftsIssue, escalateSecrets, publishReview, voidStale, type IssueState } from './deliver';
import { writeRecord } from './record';

export interface RunOptions {
  pr: number;
  trigger: string;
  /** Files a security approver cleared to skip after a secret escalation. */
  excludeFiles?: string[];
}

/** The ten steps. Only steps 06 and 07 call a model; everything else is deterministic code. */
export async function runReview(opts: RunOptions) {
  const t0 = Date.now();
  const o = gh();
  const r = repoRef();

  // 01 Ingest + 02 Fetch PR
  const { data: pr } = await o.pulls.get({ ...r, pull_number: opts.pr });
  const sha = pr.head.sha;
  const baseSha = pr.base.sha;
  const record: Record<string, any> = {
    pr: opts.pr, sha, baseSha, trigger: opts.trigger, run: runUrl(),
    models: { reviewer: modelIds.reviewer(), verifier: modelIds.verifier() },
  };
  const finish = (outcome: string, md: string) => {
    record.outcome = outcome;
    record.durationMs = Date.now() - t0;
    writeRecord(`review-pr${opts.pr}-${sha.slice(0, 7)}`, record, `### AI review: PR #${opts.pr} @ ${sha.slice(0, 7)}\n\n**Outcome:** ${outcome}\n\n${md}`);
    return { outcome, record };
  };

  if (pr.state !== 'open') return finish('skipped', 'PR is not open.');
  if (pr.head.repo?.full_name !== `${r.owner}/${r.repo}`) return finish('skipped', 'PRs from forks are not reviewed in this POC.');
  await setStatus(o, r, sha, 'pending', 'AI review running', runUrl());
  await voidStale(o, r, opts.pr, sha);

  const files = (await o.paginate(o.pulls.listFiles, { ...r, pull_number: opts.pr, per_page: 100 })) as PrFile[];

  // 03 Load rules and config from the BASE commit, so a PR cannot loosen the rules it is reviewed against.
  const cfg = parseConfig(await readRepoFile(o, r, CONFIG_PATH, baseSha));
  const ruleTexts: Record<string, string | null> = {};
  for (const f of cfg.ruleFiles) ruleTexts[f] = await readRepoFile(o, r, f, baseSha);
  const { rules, missing } = loadRules(ruleTexts);
  const projectCtx = parseContext(await readRepoFile(o, r, CONTEXT_PATH, baseSha));
  const deps = packageDeps(await readRepoFile(o, r, 'package.json', baseSha));
  const skills = skillsForProject(loadSkills(path.join(reviewerRoot(), 'skills'), cfg.disabledSkills), deps);
  Object.assign(record, { mode: cfg.mode, ruleCount: rules.length, missingRuleFiles: missing, filesChanged: files.length, projectContext: Boolean(projectCtx) });

  if (cfg.restricted) {
    await setStatus(o, r, sha, 'success', 'Restricted repo: AI review disabled by policy');
    return finish('restricted', 'Repo is marked restricted; nothing was reviewed.');
  }
  if (!rules.length) {
    await setStatus(o, r, sha, 'success', `No rules found in ${cfg.ruleFiles.join(', ')} on the base branch`);
    return finish('no-rules', `No rules found in ${cfg.ruleFiles.join(', ')} at base.`);
  }

  // 04 Policy gate
  const gate = applyPolicy(files, cfg, opts.excludeFiles);
  record.policy = {
    scanner: gate.scanner, skipped: gate.skipped, secrets: gate.secrets, hiddenContext: gate.hiddenContext,
    piiRedactions: gate.reviewable.reduce((n, f) => n + f.redactions, 0),
  };
  if (gate.secrets.length) {
    const st: IssueState = { v: 1, kind: 'secret', pr: opts.pr, sha, baseSha, requiresSecurity: true, findings: [], summary: '', secrets: gate.secrets, createdAt: new Date().toISOString() };
    const issue = await escalateSecrets(o, r, st, await securityApprovers(cfg.securityApprovers));
    record.escalationIssue = issue.number;
    return finish('escalated-secret', `${gate.secrets.length} possible secret(s). Stopped before any model call. Security issue #${issue.number}.`);
  }

  // Surrounding code: each changed file at the head commit, so hunks can be widened to the enclosing function.
  // It is secret-scanned and PII-redacted like the diff; a file with a hit gets no extra context.
  const fileLines = new Map<string, string[]>();
  const isPii = picomatch(cfg.piiRedactPaths, { dot: true });
  const wanted = [...gate.reviewable].sort((a, b) => b.parsed.addedLines.size - a.parsed.addedLines.size).slice(0, cfg.limits.maxFiles);
  for (const f of wanted) {
    const text = await readRepoFile(o, r, f.path, sha).catch(() => null);
    if (text != null && text.length < 400_000) fileLines.set(f.path, (isPii(f.path) ? redactPii(text).text : text).split('\n'));
  }
  const ctxScan = scanLines(new Map([...fileLines].map(([p, ls]) => [p, new Map(ls.map((t, i) => [i + 1, t]))])));
  const contextNotes: string[] = [];
  for (const p of new Set(ctxScan.hits.map((h) => h.file))) {
    fileLines.delete(p);
    contextNotes.push(`${p}: surrounding code not shown to the model (possible secret in unchanged code; worth a look)`);
  }

  // 05 Plan
  const planned = plan(gate.reviewable, rules, skills, cfg, projectCtx, fileLines);
  planned.notes.push(...contextNotes);
  for (const h of gate.hiddenContext) planned.notes.push(`${h.file}:${h.line}: unchanged line hidden from the model (possible secret already in the code, ${h.rule})`);
  const skipped = [...gate.skipped, ...planned.skipped];
  record.plan = {
    files: planned.tasks.map((t) => ({
      path: t.file.path, chunks: t.chunks.length, rules: t.rules.length, skills: t.skills.map((s) => `${s.name}@${s.version}`),
      expandedRadius: t.expandedRadius, projectContext: Boolean(t.contextText),
    })),
    skipped,
    notes: planned.notes,
  };
  if (!planned.tasks.length) {
    await setStatus(o, r, sha, 'success', 'Nothing to review after policy and plan');
    return finish('nothing-to-review', skipped.map((s) => `- ${s.path}: ${s.reason}`).join('\n'));
  }

  // 06 Review each file (model) + 07 Verify findings (model)
  const budget = new CallBudget(cfg.limits.maxModelCalls, cfg.limits.concurrency, cfg.limits.minIntervalMs);
  const reviewed = await reviewAll(planned.tasks, budget);
  const verified = await verifyAll(reviewed.findings, planned.tasks, budget, cfg.limits.minConfidence, cfg.limits.maxComments);
  const notes = [
    ...planned.notes,
    ...reviewed.errors.map((e) => `Review failed for ${e.path}: ${e.error}`),
    ...verified.errors.map((e) => `Verifier error: ${e}`),
  ];
  Object.assign(record, {
    modelCalls: budget.used,
    rawFindings: reviewed.findings.length,
    kept: verified.kept,
    dropped: verified.dropped.map((d) => ({ path: d.finding.path, line: d.finding.line, ruleId: d.finding.ruleId, stage: d.stage, reason: d.reason })),
    errors: notes,
  });

  const skillNames = [...new Set(planned.tasks.flatMap((t) => t.skills.map((s) => `${s.name}@${s.version}`)))];
  const mkSummary = (via: string) =>
    summaryBody({ findings: verified.kept, reviewedFiles: planned.tasks.length, skipped, ruleCount: rules.length, ruleFiles: cfg.ruleFiles, baseSha, skills: skillNames, notes, via });

  if (reviewed.errors.length && !reviewed.findings.length && reviewed.errors.length >= planned.tasks.length) {
    await setStatus(o, r, sha, 'error', 'AI review failed to call the model (see run log)', runUrl());
    return finish('model-error', notes.join('\n'));
  }

  // 08 Shadow mode? Critical security findings always go through security approval.
  const requiresSecurity = verified.kept.some((f) => f.severity === 'critical' && f.category === 'security');
  if (!verified.kept.length) {
    await setStatus(o, r, sha, 'success', 'AI review: no rule breaches found', runUrl());
    return finish('no-findings', mkSummary('nothing to post'));
  }
  if (cfg.mode === 'shadow' || requiresSecurity) {
    const approvers = requiresSecurity ? await securityApprovers(cfg.securityApprovers) : cfg.approvers;
    const st: IssueState = { v: 1, kind: 'drafts', pr: opts.pr, sha, baseSha, requiresSecurity, findings: verified.kept, summary: '', createdAt: new Date().toISOString() };
    st.summary = mkSummary(requiresSecurity ? 'security escalation, approved in the drafts issue' : 'shadow mode, approved in the drafts issue');
    const issue = await createDraftsIssue(o, r, st, approvers);
    record.draftsIssue = issue.number;
    return finish(requiresSecurity ? 'escalated-security-finding' : 'drafted', `${verified.kept.length} draft comment(s) in #${issue.number}, waiting for /approve.\n\n${st.summary}`);
  }

  // 09 Publish (direct mode)
  const url = await publishReview(o, r, opts.pr, sha, verified.kept, mkSummary('direct mode'));
  record.publishedUrl = url;
  return finish('published', `${verified.kept.length} comment(s) published: ${url}`);

  async function securityApprovers(configured: string[]) {
    if (configured.length) return configured;
    // Fallback: the repo owner when it is a user account (common for a personal POC).
    return (await permissionOf(o, r, r.owner)) === 'admin' ? [r.owner] : [];
  }
}

function packageDeps(json: string | null): Set<string> {
  try {
    const p = JSON.parse(json ?? '{}');
    return new Set([...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}
