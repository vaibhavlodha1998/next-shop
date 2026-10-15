# AI PR Reviewer

A first-pass reviewer for pull requests. It learns your project once, then reviews every PR against your own rules with that context. Every comment cites a rule, and humans keep the final say.

- **Agents (Mastra):** Analyst, Rule writer, Reviewer, Verifier, Responder. The Reviewer and Responder use **on-demand skills and read-only tools**
- **Runs in GitHub Actions:** no servers to run
- **Models:** the GitHub Models free tier, using the workflow's own token, so no API key is needed
- **Repos:** works on any repo and any language, private repos on a free account included

## Install into a repo

1. **Copy two folders** into the repo root: `.ai-review/` and `.github/`. If the repo already has a `.github/` folder, copy in only `.github/workflows/ai-review*.yml` and `.github/actions/setup-reviewer/`.
2. **Keep your linter out of it.** For a Next.js or ESLint project, add `".ai-review/**"` to the ignores in `eslint.config.mjs`. TypeScript and `next build` already skip it, because the folder name starts with a dot.
3. **Let Actions open the analysis PR:** Settings > Actions > General > Workflow permissions > tick "Allow GitHub Actions to create and approve pull requests". Without it, the branch is still pushed and you get a link to open the PR yourself.
4. **Commit and push to the default branch.** Reviews run the reviewer code from the PR's base branch, so it has to be there first.

## First run: let it learn the project

Go to Actions > **ai-review-analyze** > Run workflow, or comment `/ai-review analyze` on any issue or PR. It opens a PR with:

- **`.ai-review/project-context.md`:**
  - Stack facts found without a model: framework versions, router, `cacheComponents`, route handlers, Server Actions, client and server-only modules, path aliases, tests and lint config.
  - A short summary per module: its purpose, key files, the conventions the code follows, and what to check when it changes.
- **Starter rules in `AGENTS.md`**, only if there are none yet. They're appended in a marked block, and anything already in the file (such as the Next.js agent block) is left alone.

**Read it, fix what's wrong, and merge.** The reviewer only trusts what you merge.

Rerun the analysis after big structural changes. It also runs on the 1st of each month, and opens no PR when nothing changed.

## What happens on every PR

| # | Step | Model? |
|---|---|---|
| 1-2 | The PR event fires; the diff is fetched through the API. PR code is never checked out or run | |
| 3 | Rules (`AGENTS.md`), config and project context are read from the **base** branch, so a PR cannot change its own rules | |
| 4 | Policy gate. A secret on an added line stops the run and opens a security issue. A secret already in unchanged code is masked from the model. Env files, lockfiles, vendored and generated code are skipped. PII in test files is redacted | |
| 5 | Plan. For each file: matching rules, its module's context, the **whole enclosing function** from the head commit, and the skills catalog for that file (`nextjs-review` only if the project uses `next`), all within the token budget | |
| 6 | **Reviewer agent** (gpt-4.1) per file: loads a skill on demand, may call read-only tools (`read_file`, `find_usages`) for up to 2 steps, then must answer with typed findings | ✅ |
| 7 | Contract check (the cited rule must exist; the line must be an added line), then the **Verifier** (gpt-4.1-mini) | ✅ |
| 8 | `shadow` mode, or any critical security finding, sends drafts to an issue to wait for `/approve` | |
| 9-10 | Inline comments citing rules, a commit status, and a JSON record kept as a workflow artifact | |

## Agents, skills and tools

**Rules say what. Skills say how. Tools let the agent check.**

| Agent | Model | Tools | Job |
|---|---|---|---|
| Analyst | fast | none (code is sampled for it) | Summarises each module during `analyze` |
| Rule writer | large | none | Drafts starter rules when a repo has none |
| Reviewer | large | `skill`, `read_file`, `find_usages` | Reviews one file's diff against the rules; returns typed findings |
| Verifier | fast | none | Keeps only findings that cite a real rule on a changed line and hold up |
| Responder | large | `read_file`, `find_usages` | Answers `why?` and `show an example` in review threads |

- **Skills** are [Agent Skills](https://agentskills.io) folders in `reviewer/skills/`, loaded through Mastra's native skills support. For each file the Reviewer sees a catalog of only the skills that match it (by path, and by dependency for framework skills), and loads one with the `skill` tool when it needs it. `review-core` is always inline.
- **Tools are read-only.**
  - Files changed in the PR are read at the PR's commit; everything else comes from the base checkout.
  - Excluded paths (env files, keys, lockfiles, vendored or generated code) are refused.
  - Test files are PII-redacted, and any line the secret scan flags is masked before the model sees it.
- **Hard limits on the loop:**
  - Tools are switched off after `maxToolSteps` steps, so the next step must be the answer.
  - Tool output is capped per file, and every model request is paced.
  - Each run stays inside its call budget, and unused calls are refunded.
- **Agents never write.** Only the pipeline scripts post to GitHub, after their own checks.
- **Every review record** (workflow artifact) lists, per file, the steps taken, skills loaded, tool calls and whether the answer was forced.

Set `reviewer.tools: false` (or the repo variable `AI_REVIEW_TOOLS=false`) for single-call mode: one request per file with the skills inlined.

## Commands

| Where | Command |
|---|---|
| Any issue or PR | `/ai-review analyze` re-learns the project (write access needed) |
| PR conversation | `/ai-review rerun` reviews the latest commit again |
| Drafts or security issue | `/approve` or `/reject`. Approval is tied to the exact commit; a new push voids it |
| Reply on an AI comment | `why?` or `show an example` get an answer from the Responder. `/ai dismiss` and `/ai wrong-rule` are recorded as labels and feed the weekly digest |

## Settings: `.ai-review/config.yml`

- **`mode`:** `shadow` (drafts wait for `/approve`) or `direct`
- **People:** `approvers`, `securityApprovers`
- **Scope:** `restricted`, `ruleFiles`, `excludePaths`, `disabledSkills`
- **`reviewer`:** `tools` (agentic mode on or off), `maxToolSteps`, `maxToolOutputChars`
- **`limits`:** files, model calls, pacing and comment caps per run. `maxAnalyzeCalls` is for the analysis

To switch model provider without changing code, set repository variables: `LLM_BASE_URL`, `REVIEWER_MODEL`, `VERIFIER_MODEL`, `ANALYST_MODEL`, and the secret `LLM_API_KEY`. Any OpenAI-compatible endpoint works.

## Free tier budget

GitHub Models free tier limits each request to **8,000 input tokens**:

- **gpt-4.1:** 10 requests/min and 50/day
- **gpt-4.1-mini:** 15 requests/min and 150/day

So prompts are budgeted to fit and split when needed, and each run is capped.

- **One analysis:** one fast-model call per module, plus one large-model call for rules.
- **One small PR review:** with tools, up to 3 calls per file plus 1 for the Verifier. A 3-file PR uses about 10, so expect around 5 reviews a day on gpt-4.1. Single-call mode uses about 4.
- **Paid model or another provider:** raise `limits.maxModelCalls` and set `minIntervalMs: 0`.

## Local runs

```bash
cd .ai-review/reviewer
npm install
npm test                       # offline end-to-end test on a Next.js fixture (mock GitHub + mock model)
cp .env.example .env           # add a fine-grained PAT for GitHub Models / the repo
npm run analyze -- --write     # writes project-context.md (and starter rules) into your working copy
npm run review -- --pr 12      # reviews a real PR from your machine
npm run dev                    # Mastra playground with all five agents
```

## Layout

```
.ai-review/
  config.yml                 per-repo settings
  project-context.md         written by analyze, edited by you
  reviewer/                  the Mastra project
    src/analyze/             scan, context file, analysis run
    src/mastra/              agents, read-only tools, step control and pacing, models, guardrails, schemas
    src/pipeline/            plan, review, verify, deliver, respond, record
    src/lib/                 config, rules, diff, policy gate, skills, GitHub helpers
    src/cli/                 analyze.ts, review.ts, command.ts, digest.ts
    skills/                  review checklists (nextjs, typescript, security, java, python, ...)
    test/                    mocks, Next.js fixture, e2e test
.github/
  workflows/ai-review*.yml   review, commands, analyze, digest
  actions/setup-reviewer/    Node, dependencies, Gitleaks
```
