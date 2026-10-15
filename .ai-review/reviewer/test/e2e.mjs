// Offline end-to-end test on a real Next.js app fixture: mock GitHub API + mock model, real pipeline code.
//   npm test          (needs git; uses gitleaks if it is on PATH, otherwise the built-in secret patterns)
//
// PRs are built as real git commits on a temp copy of test/fixtures/next-app, so diffs are exactly what
// GitHub would return. Fake secrets are assembled at runtime so no secret-looking string is ever committed.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const reviewer = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-e2e-'));
const keep = process.env.E2E_KEEP === '1';
const repo = path.join(tmp, 'repo');
const GH = 'http://127.0.0.1:4520';
const LLM = 'http://127.0.0.1:4510';
const FAKE_STRIPE = 'sk_' + 'live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3';
const FAKE_GH_TOKEN = 'ghp_' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa9';
let procs = [];
const mockLog = path.join(tmp, 'mock-github.log');

// ---------------- fixture repo and PRs ----------------
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
fs.cpSync(path.join(here, 'fixtures/next-app'), repo, { recursive: true });
// A secret that already lives in the code base (the analyzer must not send it; reviews must hide it).
fs.writeFileSync(path.join(repo, 'src/lib/legacy.ts'), `// Old config kept for the migration script.\nexport const LEGACY_KEY = "${FAKE_STRIPE}";\nexport const LEGACY_TIMEOUT_MS = 5000;\n`);
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'test');
git('add', '-A');
git('commit', '-qm', 'base');

function makePr(number, branch, edit) {
  git('checkout', '-q', '-b', branch);
  edit((p) => path.join(repo, p));
  git('add', '-A');
  git('commit', '-qm', branch);
  const head = git('rev-parse', 'HEAD');
  const base = git('rev-parse', 'main');
  const files = git('diff', '--numstat', `main..${branch}`).split('\n').filter(Boolean).map((l) => {
    const [a, d, f] = l.split('\t');
    const raw = git('diff', `main..${branch}`, '--', f);
    const status = git('diff', '--name-status', `main..${branch}`, '--', f).startsWith('A') ? 'added' : 'modified';
    return { filename: f, status, additions: +a, deletions: +d, patch: raw.slice(raw.indexOf('@@')) };
  });
  const headFiles = Object.fromEntries(files.map((f) => [f.filename, fs.readFileSync(path.join(repo, f.filename), 'utf8')]));
  git('checkout', '-q', 'main');
  const out = path.join(tmp, `pr${number}.json`);
  fs.writeFileSync(out, JSON.stringify({ number, head, base, files, headFiles }));
  return out;
}
const append = (file, text) => fs.appendFileSync(file, text);
const replace = (file, a, b) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(a, b));

const prFixtures = [
  // PR 7: rule breaks across a Server Action, a new route handler and a client component.
  makePr(7, 'feat/orders', (f) => {
    append(f('src/app/cart/actions.ts'), `
// TODO cleanup
export async function removeFromCart(productId: string) {
  const session = getSession();
  console.log("removing", productId, session);
  return { ok: true };
}
`);
    fs.mkdirSync(f('src/app/api/orders'), { recursive: true });
    fs.writeFileSync(f('src/app/api/orders/route.ts'), `import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const userId = new URL(request.url).searchParams.get("user");
  const rows = await query(\`SELECT * FROM orders WHERE user_id = '\${userId}'\`);
  return NextResponse.json(rows);
}

async function query(sql: string): Promise<unknown[]> {
  return [sql];
}
`);
    replace(f('src/components/AddToCartButton.tsx'), 'await addToCart(productId, 1);', 'await addToCart(productId, quantity);');
  }),
  // PR 8: a new secret on an added line.
  makePr(8, 'feat/admin-token', (f) => append(f('src/lib/products.ts'), `\nconst ADMIN_TOKEN = "${FAKE_GH_TOKEN}";\nexport const adminHeaders = { authorization: ADMIN_TOKEN };\n`)),
  // PR 9: touches a line next to a secret that was already in the code.
  makePr(9, 'chore/timeout', (f) => replace(f('src/lib/legacy.ts'), 'LEGACY_TIMEOUT_MS = 5000', 'LEGACY_TIMEOUT_MS = 8000')),
];

// ---------------- harness ----------------
async function startMocks({ mode = '', noCritical = false, rejectSchema = false, brokenModel = '', okIf = '' } = {}) {
  procs.forEach((p) => p.kill());
  await new Promise((r) => setTimeout(r, 200));
  procs = [
    spawn('node', [path.join(here, 'mock-llm.mjs'), '4510'], {
      env: { ...process.env, MOCK_NO_CRITICAL: noCritical ? '1' : '', MOCK_REJECT_SCHEMA: rejectSchema ? '1' : '', MOCK_BROKEN_MODEL: brokenModel, MOCK_OK_IF: okIf },
      stdio: 'ignore',
    }),
    spawn('node', [path.join(here, 'mock-github.mjs'), '4520', repo, ...prFixtures], {
      env: { ...process.env, MOCK_FAST: '1', MOCK_MODE: mode },
      stdio: ['ignore', fs.openSync(mockLog, 'a'), fs.openSync(mockLog, 'a')],
    }),
  ];
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${GH}/__state`);
      await fetch(`${LLM}/__log`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('mocks did not start');
}

const env = {
  ...process.env,
  GITHUB_API_URL: GH, GITHUB_REPOSITORY: 'acme/demo', GITHUB_TOKEN: 'test', LLM_BASE_URL: LLM, LLM_API_KEY: 'test',
  AI_REVIEW_OUT: path.join(tmp, 'out'), GITHUB_STEP_SUMMARY: path.join(tmp, 'summary.md'), AI_REVIEW_MODE: '', REPO_ROOT: repo,
  GITHUB_EVENT_NAME: '', GITHUB_EVENT_PATH: '', GITHUB_SHA: '',
};
const tsx = path.join(reviewer, 'node_modules/.bin/tsx');
function cli(script, extra = {}, event, args = []) {
  const e = { ...env, ...extra };
  if (event) {
    const p = path.join(tmp, `event-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(p, JSON.stringify(event.payload));
    Object.assign(e, { GITHUB_EVENT_NAME: event.name, GITHUB_EVENT_PATH: p });
  }
  const r = spawnSync(tsx, [path.join(reviewer, 'src/cli', script), ...args], { cwd: reviewer, env: e, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${script} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
const state = async () => (await fetch(`${GH}/__state`)).json();
const llmLog = async () => (await fetch(`${LLM}/__log`)).json();
const outcome = (out) => out.match(/outcome: (\S+)/)?.[1];
const issueComment = (issue, user, body) => ({ name: 'issue_comment', payload: { action: 'created', issue: { number: issue.number, state: 'open', body: issue.body }, comment: { id: 1, body, user: { login: user, type: 'User' } } } });
async function humanReply(pr, parentId, body) {
  const c = await (await fetch(`${GH}/__human-reply`, { method: 'POST', body: JSON.stringify({ pr, body, user: 'dev', in_reply_to_id: parentId }) })).json();
  return { name: 'pull_request_review_comment', payload: { action: 'created', pull_request: { number: pr }, comment: { ...c, user: { login: 'dev', type: 'User' } } } };
}
const lastRecord = (prefix) => {
  const dir = env.AI_REVIEW_OUT;
  const f = fs.readdirSync(dir).filter((x) => x.startsWith(prefix)).map((x) => path.join(dir, x)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs).at(-1);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};
const step = (name) => console.log(`\n▶ ${name}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

try {
  // ================= analyze =================
  await startMocks({ noCritical: true });

  step('analyze: falls back to a pushed branch when Actions may not open PRs');
  await fetch(`${GH}/__forbid-pr`, { method: 'POST', body: JSON.stringify({ value: true }) });
  assert.equal(outcome(cli('analyze.ts')), 'branch-pushed');
  assert.ok((await state()).refs['heads/ai-review/analyze'], 'branch pushed');
  await fetch(`${GH}/__forbid-pr`, { method: 'POST', body: JSON.stringify({ value: false }) });
  ok('branch ai-review/analyze pushed, compare link given');

  step('analyze: opens a PR with project context and starter rules');
  assert.equal(outcome(cli('analyze.ts')), 'pr-opened');
  let s = await state();
  const tree = s.trees.at(-1).tree;
  const ctxFile = tree.find((t) => t.path === '.ai-review/project-context.md').content;
  const agents = tree.find((t) => t.path === 'AGENTS.md').content;
  assert.match(ctxFile, /Next\.js 16\.4\.1: App Router in src\/app\//);
  assert.match(ctxFile, /cacheComponents is ON/);
  assert.match(ctxFile, /## Module: src\/app \(applies to: src\/app\/\*\*\)/);
  assert.match(ctxFile, /## Module: src\/lib \(applies to: src\/lib\/\*\*\)/);
  assert.match(agents, /BEGIN:nextjs-agent-rules[\s\S]*END:nextjs-agent-rules[\s\S]*BEGIN:ai-review-rules/, 'Next.js block kept, rules appended after it');
  assert.match(agents, /- \[NEXT-001\]/);
  assert.equal(s.pulls.length, 1);
  assert.match(s.pulls[0].body, /Please read and correct this before merging/);
  const analyzeCalls = (await llmLog()).filter((e) => /ROLE: (ANALYST|RULE WRITER)/.test(e.prompt));
  assert.ok(analyzeCalls.length >= 2 && analyzeCalls.length <= 12, `analyze used ${analyzeCalls.length} calls`);
  assert.ok(!analyzeCalls.some((e) => e.prompt.includes(FAKE_STRIPE)), 'existing secret never sent to the model');
  const arec = lastRecord('analyze-');
  assert.ok(arec.notes.some((n) => n.includes('src/lib/legacy.ts')), 'flagged file noted');
  ok(`PR opened: ${analyzeCalls.length} model calls, Next.js block preserved, legacy secret file kept away from the model`);

  step('merge the analyze PR, then rerun: nothing new');
  fs.writeFileSync(path.join(repo, '.ai-review/project-context.md'), ctxFile);
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), agents);
  git('add', '-A');
  git('commit', '-qm', 'merge analyze');
  // The mock serves the default branch from disk, so this now plays the merged state.
  const before = (await llmLog()).length;
  assert.equal(outcome(cli('analyze.ts')), 'no-change');
  assert.ok(!(await llmLog()).slice(before).some((e) => /ROLE: RULE WRITER/.test(e.prompt)), 'rules exist now, so none are drafted');
  ok('no PR when nothing changed; no rule drafting once rules exist');

  // ================= review with context =================
  step('review uses project context, the Next.js skill and the enclosing code');
  const n0 = (await llmLog()).length;
  assert.equal(outcome(cli('review.ts', { PR_NUMBER: '7' })), 'drafted');
  const reviewPrompts = (await llmLog()).slice(n0).filter((e) => e.prompt.includes('ROLE: REVIEWER'));
  const btn = reviewPrompts.find((e) => e.prompt.includes('FILE: src/components/AddToCartButton.tsx'));
  assert.ok(btn, 'button file reviewed');
  assert.match(btn.prompt, /PROJECT CONTEXT/);
  assert.match(btn.prompt, /Module src\/components/);
  assert.match(btn.prompt, /^ \s*\d+ \| export function AddToCartButton/m, 'enclosing component signature shown, beyond GitHub\'s 3 context lines');
  const rec7 = lastRecord('review-pr7');
  assert.equal(rec7.baseSha, 'b'.repeat(40), 'rules read at the base branch tip, not the stale pr.base.sha');
  assert.ok(rec7.plan.files.every((f) => f.projectContext), 'context for every file');
  assert.ok(rec7.plan.files.some((f) => f.expandedRadius > 0), 'hunks widened');
  ok('project context and the whole enclosing component reached the Reviewer');

  step('agentic review: skills on demand + read-only tools, capped steps');
  assert.deepEqual([...btn.tools].sort(), ['find_usages', 'read_file', 'skill'], 'only read-only tools and the skill loader are offered');
  assert.match(btn.prompt, /Skill: review-core/, 'review-core inline');
  assert.doesNotMatch(btn.prompt, /### Skill: nextjs-review/, 'framework skills are not inlined in tool mode');
  assert.match(btn.prompt, /<name>nextjs-review<\/name>/, 'nextjs-review offered in the catalog');
  assert.doesNotMatch(btn.prompt, /java-review/, 'irrelevant skills not even listed');
  const btnSteps = reviewPrompts.filter((e) => e.prompt.includes('FILE: src/components/AddToCartButton.tsx'));
  const results = btnSteps.flatMap((e) => e.toolResults).join('\n');
  assert.match(results, /Next\.js 16 differs from older versions/, 'skill body loaded via the skill tool');
  assert.match(results, /export async function getSession/, 'read_file returned the helper');
  assert.match(results, /src\/app\/admin\/page\.tsx:\d+:/, 'find_usages found callers');
  assert.match(results, /excluded by the review policy/, '.env.local refused');
  assert.ok(btnSteps.at(-1).tools.length === 0 || btnSteps.at(-1).toolChoice === 'none', 'tools switched off at the step cap');
  assert.equal(rec7.agent.mode, 'tools');
  const trace = rec7.agent.traces.find((t) => t.path === 'src/components/AddToCartButton.tsx');
  assert.equal(trace.steps, 3);
  assert.equal(trace.forcedAnswer, true);
  assert.ok(trace.skillsLoaded.includes('nextjs-review'));
  assert.ok(trace.toolCalls.some((c) => c.note === 'refused by policy'));
  ok(`loop per file: skill loaded, ${trace.toolCalls.length} tool calls, answer forced at step ${trace.steps}; ${rec7.modelCalls} model requests in total`);

  s = await state();
  const drafts = s.issues.at(-1);
  assert.match(drafts.title, /AI review drafts: PR #7/);
  assert.equal(s.reviews.length, 0);
  ok(`shadow mode: drafts issue #${drafts.number}, nothing posted on the PR`);

  step('approval permissions');
  cli('command.ts', {}, issueComment(drafts, 'stranger', '/approve'));
  assert.equal((await state()).reviews.length, 0);
  cli('command.ts', {}, issueComment(drafts, 'dev', '/approve'));
  s = await state();
  assert.equal(s.reviews.length, 1);
  assert.ok(s.reviewComments.length >= 3);
  ok(`stranger refused; writer approved; ${s.reviewComments.length} inline comments published`);

  step('Responder, feedback and digest');
  const parent = s.reviewComments[0];
  cli('command.ts', {}, await humanReply(7, parent.id, 'why?'));
  cli('command.ts', {}, await humanReply(7, parent.id, '/ai dismiss'));
  s = await state();
  assert.equal(s.reviewComments.filter((c) => c.in_reply_to_id === parent.id && c.user.type === 'Bot').length, 2);
  const responder = (await llmLog()).filter((e) => e.prompt.includes('ROLE: RESPONDER'));
  assert.ok(responder[0].tools.includes('read_file') && responder.some((e) => e.toolResults.join('').includes('getSession')), 'Responder used read_file');
  assert.deepEqual(s.prLabels['7'], ['ai-feedback:dismissed']);
  assert.match(cli('digest.ts'), /Digest:/);
  ok('why? answered, /ai dismiss labelled, digest issue created');

  step('new secret on an added line: stop before any model call');
  const n1 = (await llmLog()).length;
  assert.equal(outcome(cli('review.ts', { PR_NUMBER: '8' })), 'escalated-secret');
  assert.equal((await llmLog()).length, n1, 'no model calls');
  s = await state();
  assert.ok(!JSON.stringify(s).includes(FAKE_GH_TOKEN), 'secret value never copied');
  const sec = s.issues.at(-1);
  cli('command.ts', {}, issueComment(sec, 'dev', '/approve'));
  assert.equal((await state()).issues.find((i) => i.number === sec.number).state, 'open', 'writer cannot clear security');
  cli('command.ts', {}, issueComment(sec, 'acme', '/approve'));
  assert.match((await state()).issueComments.at(-1).body, /excluding/);
  ok('0 model calls, value never copied, only the security approver could clear it');

  step('secret already in the code next to a change: hidden, review continues');
  const n2 = (await llmLog()).length;
  assert.equal(outcome(cli('review.ts', { PR_NUMBER: '9' })), 'drafted');
  const p9 = (await llmLog()).slice(n2).map((e) => e.prompt).join('\n');
  assert.ok(p9.includes('FILE: src/lib/legacy.ts'));
  assert.ok(!p9.includes(FAKE_STRIPE), 'existing secret not sent');
  assert.match(p9, /line hidden: possible secret in unchanged code/);
  const p9tools = (await llmLog()).slice(n2).flatMap((e) => e.toolResults ?? []).join('\n');
  assert.ok(p9tools.includes('src/lib/legacy.ts') || p9tools.includes('LEGACY_'), 'the agent read the file through read_file');
  assert.ok(!p9tools.includes(FAKE_STRIPE), 'read_file masked the secret too');
  const rec9 = lastRecord('review-pr9');
  assert.equal(rec9.policy.hiddenContext.length, 1);
  ok('the existing key was masked in the diff and the surrounding code withheld; the PR was still reviewed');

  // ================= escalation, voiding, direct, fallback =================
  await startMocks();
  step('critical security finding forces security approval; a new push voids it');
  assert.equal(outcome(cli('review.ts', { PR_NUMBER: '7' })), 'escalated-security-finding');
  const crit = (await state()).issues.at(-1);
  assert.match(crit.title, /^\[SECURITY\] AI review drafts/);
  await fetch(`${GH}/__set-head`, { method: 'POST', body: JSON.stringify({ pr: 7, sha: 'f'.repeat(40) }) });
  cli('command.ts', {}, issueComment(crit, 'acme', '/approve'));
  s = await state();
  assert.equal(s.reviews.length, 0);
  assert.ok(s.issues.find((i) => i.number === crit.number).labels.some((l) => l.name === 'ai-review:voided'));
  ok('SQL built from a query param escalated; approval after a new push was voided');

  await startMocks({ mode: 'direct', noCritical: true });
  step('direct mode publishes straight to the PR');
  assert.equal(outcome(cli('review.ts', { PR_NUMBER: '7' })), 'published');
  s = await state();
  assert.equal(s.issues.length, 0);
  assert.equal(s.statuses.at(-1).state, 'success');
  ok(`${s.reviewComments.length} comments published, commit status success`);

  step('single-call mode (AI_REVIEW_TOOLS=false): one request per file, skills inlined');
  const n3 = (await llmLog()).length;
  assert.equal(outcome(cli('review.ts', { PR_NUMBER: '7', AI_REVIEW_TOOLS: 'false' })), 'published');
  const single = (await llmLog()).slice(n3).filter((e) => e.prompt.includes('ROLE: REVIEWER'));
  assert.equal(single.length, 3, 'one request per file');
  assert.ok(single.every((e) => !e.tools.length), 'no tools offered');
  assert.ok(single.some((e) => /### Skill: nextjs-review/.test(e.prompt)), 'framework skill inlined');
  ok('3 reviewer requests, no tools, skills inlined');

  await startMocks({ mode: 'direct', noCritical: true, rejectSchema: true });
  step('falls back to prompt-injected JSON when the provider rejects json_schema');
  assert.equal(outcome(cli('review.ts', { PR_NUMBER: '7' })), 'published');
  // Before the run switches shape: each in-flight Reviewer call (2) once per model in the fallback chain (2),
  // plus the Verifier's first native attempt.
  assert.ok((await llmLog()).filter((x) => x.rejected).length <= 6);
  ok('completed with prompt-injected JSON');

  await startMocks({ mode: 'direct', noCritical: true, brokenModel: 'openai/gpt-4.1' });
  step('primary model broken (200 "OK" plain text): falls back to the second model');
  assert.equal(outcome(cli('review.ts', { PR_NUMBER: '7' })), 'published');
  const fb = await llmLog();
  assert.ok(fb.some((e) => e.broken), 'gpt-4.1 was tried');
  assert.ok(fb.some((e) => !e.broken && e.model === 'openai/gpt-4.1-mini' && e.prompt.includes('ROLE: REVIEWER')), 'reviewer answered on gpt-4.1-mini');
  ok(`${fb.filter((e) => e.broken).length} broken responses, review completed on the fallback model`);

  await startMocks({ mode: 'direct', noCritical: true, okIf: 'tools+schema' });
  step('GitHub Models quirk: "OK" for tools + json_schema, so tool calls continue with prompt-described JSON');
  assert.equal(outcome(cli('review.ts', { PR_NUMBER: '7' })), 'published');
  let q = await llmLog();
  assert.ok(q.some((e) => e.broken && e.shape === 'tools+schema'), 'the failing shape was tried');
  assert.ok(q.some((e) => !e.broken && e.tools.includes('read_file') && !e.response_format), 'tool calls went through without response_format');
  let qrec = lastRecord('review-pr7');
  assert.ok(qrec.errors.some((n) => n.includes('switched shape')), 'the switch is recorded');
  assert.ok(qrec.agent.traces.every((t) => !t.fallback), 'still agentic');
  ok('still agentic: tools kept, JSON moved into the prompt, switch noted in the record');

  await startMocks({ mode: 'direct', noCritical: true, okIf: 'tools' });
  step('provider rejects tool calls entirely: review drops to single-call mode');
  assert.equal(outcome(cli('review.ts', { PR_NUMBER: '7' })), 'published');
  qrec = lastRecord('review-pr7');
  assert.ok(qrec.agent.traces.every((t) => t.fallback?.startsWith('single-call')), 'every file fell back');
  q = await llmLog();
  assert.ok(q.some((e) => !e.broken && e.prompt.includes('ROLE: REVIEWER') && /### Skill: nextjs-review/.test(e.prompt)), 'skills inlined in the fallback');
  ok('every file reviewed in single-call mode with skills inlined; comments published');

  console.log('\nAll end-to-end checks passed.');
} catch (e) {
  if (fs.existsSync(mockLog)) console.error('--- mock GitHub log ---\n' + fs.readFileSync(mockLog, 'utf8').slice(-3000));
  throw e;
} finally {
  if (keep) fs.writeFileSync(path.join(tmp, 'llm-log.json'), JSON.stringify(await llmLog().catch(() => [])));
  procs.forEach((p) => p.kill());
  if (keep) console.log(`kept ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}
