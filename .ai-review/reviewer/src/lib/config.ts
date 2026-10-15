import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

/** Where this reviewer project lives (skills are owned centrally, here). */
export const reviewerRoot = () => path.resolve(process.env.REVIEWER_ROOT || process.cwd());

/** The repo's own config lives at this path on the BASE branch. */
export const CONFIG_PATH = '.ai-review/config.yml';

const DEFAULT_EXCLUDES = [
  // environment config
  '**/.env', '**/.env.*', '**/*.env', '**/config/secrets*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
  // customer data fixtures
  '**/fixtures/customer*/**', '**/fixtures/prod*/**', '**/*customer*data*',
  // vendored and generated code
  'vendor/**', '**/vendor/**', 'third_party/**', '**/node_modules/**', 'dist/**', 'build/**', '**/generated/**',
  '**/*.generated.*', '**/*.min.js', '**/*.min.css', '**/*.pb.go', '**/*_pb2.py', '**/*.snap',
  // lockfiles
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/poetry.lock', '**/Pipfile.lock', '**/Cargo.lock',
  '**/go.sum', '**/Gemfile.lock', '**/composer.lock', '**/*.lock',
  // the reviewer kit itself
  '.ai-review/**',
];

const DEFAULT_PII_PATHS = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py', '**/*_test.go', '**/fixtures/**'];

const limitsSchema = z.object({
  maxFiles: z.number().int().positive().default(15),
  /** Hard cap on model calls per run (reviewer chunks + verifier batches). Free tier "High" models = 50/day. */
  maxModelCalls: z.number().int().positive().default(20),
  concurrency: z.number().int().positive().default(2),
  /** Minimum gap between model call starts. 6500ms keeps under 10 requests/minute. */
  minIntervalMs: z.number().int().nonnegative().default(6500),
  minConfidence: z.number().min(0).max(1).default(0.6),
  maxComments: z.number().int().positive().default(25),
  /** Model calls for `ai-review analyze`: one per module (fast model) plus one for starter rules. */
  maxAnalyzeCalls: z.number().int().positive().default(12),
});

const configSchema = z.object({
  /** shadow: drafts wait for /approve in a review issue. direct: publish straight to the PR. */
  mode: z.enum(['shadow', 'direct']).default('shadow'),
  /** Restricted repos are never reviewed. */
  restricted: z.boolean().default(false),
  /** GitHub logins allowed to /approve or /reject drafts. Empty: anyone with write access. */
  approvers: z.array(z.string()).default([]),
  /** GitHub logins for security escalations. Empty: repo admins only. */
  securityApprovers: z.array(z.string()).default([]),
  /** Rule files, read from the base branch. */
  ruleFiles: z.array(z.string()).default(['AGENTS.md']),
  excludePaths: z.array(z.string()).default([]),
  /** Replaces the built-in exclude list instead of adding to it. */
  replaceDefaultExcludes: z.boolean().default(false),
  piiRedactPaths: z.array(z.string()).default(DEFAULT_PII_PATHS),
  /** Skill names to switch off for this repo. */
  disabledSkills: z.array(z.string()).default([]),
  limits: limitsSchema.default(limitsSchema.parse({})),
});

export type ReviewConfig = z.infer<typeof configSchema> & { excludeGlobs: string[] };

export function parseConfig(yamlText: string | null): ReviewConfig {
  const raw = yamlText ? (YAML.parse(yamlText) ?? {}) : {};
  const cfg = configSchema.parse(raw);
  const envMode = process.env.AI_REVIEW_MODE;
  if (envMode === 'shadow' || envMode === 'direct') cfg.mode = envMode;
  const excludeGlobs = cfg.replaceDefaultExcludes ? cfg.excludePaths : [...DEFAULT_EXCLUDES, ...cfg.excludePaths];
  return { ...cfg, excludeGlobs };
}
