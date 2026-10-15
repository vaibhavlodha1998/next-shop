import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import picomatch from 'picomatch';
import type { ReviewConfig } from './config';
import { parsePatch, type ParsedPatch } from './diff';

/**
 * Step 04, the policy gate. Runs BEFORE any model call and decides what may
 * reach the model at all:
 *   - restricted repos: not reviewed
 *   - excluded paths (env config, customer fixtures, vendored/generated code, lockfiles): skipped
 *   - secrets (Gitleaks, with a regex fallback): the run stops and security is alerted
 *   - personal data in test files: redacted
 *   - whole files are never sent, only the patch (changed lines plus 3 lines of context)
 */

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface ReviewableFile {
  path: string;
  patch: string;
  parsed: ParsedPatch;
  redactions: number;
}

export interface SecretHit {
  file: string;
  line: number;
  rule: string;
}

export interface GateResult {
  reviewable: ReviewableFile[];
  skipped: { path: string; reason: string }[];
  secrets: SecretHit[];
  /** Possible secrets on UNCHANGED context lines: hidden from the model, reported, but not blocking. */
  hiddenContext: SecretHit[];
  scanner: 'gitleaks' | 'builtin';
}

export const HIDDEN_LINE = '[line hidden: possible secret in unchanged code]';

export function applyPolicy(files: PrFile[], cfg: ReviewConfig, extraExcluded: string[] = []): GateResult {
  const isExcluded = picomatch(cfg.excludeGlobs, { dot: true });
  const isPiiPath = picomatch(cfg.piiRedactPaths, { dot: true });
  const reviewable: ReviewableFile[] = [];
  const skipped: GateResult['skipped'] = [];

  for (const f of files) {
    if (extraExcluded.includes(f.filename)) skipped.push({ path: f.filename, reason: 'excluded after security escalation' });
    else if (f.status === 'removed') skipped.push({ path: f.filename, reason: 'file deleted' });
    else if (!f.patch) skipped.push({ path: f.filename, reason: 'binary, renamed without changes, or diff too large for the API' });
    else if (isExcluded(f.filename)) skipped.push({ path: f.filename, reason: 'excluded path (policy)' });
    else {
      let patch = f.patch;
      let redactions = 0;
      if (isPiiPath(f.filename)) ({ text: patch, count: redactions } = redactPii(patch));
      const parsed = parsePatch(patch);
      if (!parsed.addedLines.size) skipped.push({ path: f.filename, reason: 'no added lines' });
      else reviewable.push({ path: f.filename, patch, parsed, redactions });
    }
  }

  // Secret scan covers every changed file that has a patch, including excluded ones:
  // a secret in an excluded .env file still has to be escalated.
  // Context lines are scanned too: a secret already in the file must not reach the model either.
  const scanTargets = files.filter((f) => f.patch && f.status !== 'removed' && !extraExcluded.includes(f.filename));
  const { hits, scanner } = scanSecrets(scanTargets);
  const addedByFile = new Map(scanTargets.map((f) => [f.filename, parsePatch(f.patch!).addedLines]));
  const secrets = hits.filter((h) => addedByFile.get(h.file)?.has(h.line));
  const hiddenContext = hits.filter((h) => !addedByFile.get(h.file)?.has(h.line));
  for (const h of hiddenContext) {
    const rf = reviewable.find((x) => x.path === h.file);
    for (const hunk of rf?.parsed.hunks ?? []) for (const l of hunk.lines) if (l.kind === 'ctx' && l.newLine === h.line) l.text = HIDDEN_LINE;
  }
  return { reviewable, skipped, secrets, hiddenContext, scanner };
}

// ---------- secrets ----------

function scanSecrets(files: PrFile[]): { hits: SecretHit[]; scanner: GateResult['scanner'] } {
  // Rebuild each file's added and context lines at their real line numbers, so reports map straight back to the diff.
  const added = new Map<string, Map<number, string>>();
  for (const f of files) {
    const parsed = parsePatch(f.patch!);
    const lines = new Map<number, string>();
    for (const h of parsed.hunks) for (const l of h.lines) if (l.kind !== 'del') lines.set(l.newLine!, l.text);
    added.set(f.filename, lines);
  }
  return scanLines(added);
}

/**
 * Secret scan over arbitrary text: file path -> (line number -> text). Used for PR diffs, for the
 * surrounding code shown to the Reviewer, and for the files the analyzer samples.
 */
export function scanLines(added: Map<string, Map<number, string>>): { hits: SecretHit[]; scanner: GateResult['scanner'] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-scan-'));
  for (const [file, lines] of added) {
    const max = Math.max(0, ...lines.keys());
    const body = Array.from({ length: max }, (_, i) => lines.get(i + 1) ?? '').join('\n');
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }

  try {
    const bin = process.env.GITLEAKS_BIN || 'gitleaks';
    const report = path.join(dir, '..', path.basename(dir) + '-report.json');
    const res = spawnSync(bin, ['dir', dir, '--report-format', 'json', '--report-path', report, '--no-banner', '--redact', '--exit-code', '0', '--log-level', 'error'], {
      encoding: 'utf8',
    });
    if (!res.error && res.status === 0 && fs.existsSync(report)) {
      const findings = JSON.parse(fs.readFileSync(report, 'utf8') || '[]') as { RuleID: string; File: string; StartLine: number }[];
      fs.rmSync(report, { force: true });
      return {
        scanner: 'gitleaks',
        hits: findings.map((x) => ({ file: path.relative(dir, path.resolve(dir, x.File)), line: x.StartLine, rule: x.RuleID })),
      };
    }
    if (process.env.GITLEAKS_REQUIRED === 'true') {
      throw new Error(`Gitleaks is required but failed to run: ${res.error?.message ?? res.stderr}`);
    }
    // Local runs without gitleaks installed fall back to a small built-in pattern set.
    return { scanner: 'builtin', hits: builtinScan(added) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['aws-access-key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['private-key', /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['stripe-live-key', /\b[sr]k_live_[A-Za-z0-9]{20,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['generic-assigned-secret', /\b(api[_-]?key|secret|passwd|password|token|client[_-]?secret)\b\s*[:=]\s*['"][A-Za-z0-9+/_\-!@#$%^&*.]{12,}['"]/i],
];

function builtinScan(added: Map<string, Map<number, string>>): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const [file, lines] of added)
    for (const [line, text] of lines)
      for (const [rule, re] of SECRET_PATTERNS) if (re.test(text)) hits.push({ file, line, rule });
  return hits;
}

// ---------- personal data ----------

const PII_PATTERNS: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
  [/(?<![\w.])(\+?\d{1,3}[\s-]?)?(\(?\d{2,5}\)?[\s-]?)\d{3,4}[\s-]?\d{3,4}(?![\w.])/g, '[REDACTED_PHONE]'],
  [/\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g, '[REDACTED_NINO]'], // UK National Insurance number
  [/\b(?:\d[ -]?){13,16}\b/g, '[REDACTED_CARD]'],
  [/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g, '[REDACTED_POSTCODE]'], // UK postcode
];

export function redactPii(patch: string): { text: string; count: number } {
  let count = 0;
  const text = patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('@@')) return line;
      let out = line;
      for (const [re, rep] of PII_PATTERNS) out = out.replace(re, () => (count++, rep));
      return out;
    })
    .join('\n');
  return { text, count };
}
