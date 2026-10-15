import { z } from 'zod';

// Strict output contracts. Every field is required (nullable instead of optional)
// so the schema works with OpenAI-style strict json_schema response formats.

export const severity = z.enum(['critical', 'major', 'minor', 'nit']);
export const category = z.enum(['security', 'correctness', 'performance', 'maintainability', 'testing', 'style', 'docs']);

export const reviewerFinding = z.object({
  ruleId: z.string().describe('Exact id of the rule this finding cites, copied from the RULES list'),
  line: z.number().describe('New-file line number of an ADDED line (marked +) that the finding is about'),
  severity,
  category,
  title: z.string().describe('Short headline, under 80 characters'),
  message: z.string().describe('What is wrong and why it breaks the rule, 1 to 3 sentences'),
  suggestion: z
    .string()
    .nullable()
    .describe('Optional replacement code for exactly that one line, no backticks; null when not applicable'),
  // No min/max keywords: some strict json_schema endpoints reject them. Clamped in code instead.
  confidence: z.number().describe('0 to 1'),
});
export const reviewerOutput = z.object({ findings: z.array(reviewerFinding) });

export const verifierVerdict = z.object({
  id: z.string(),
  keep: z.boolean(),
  severity: severity.nullable().describe('Corrected severity, or null to keep the original'),
  reason: z.string(),
});
export const verifierOutput = z.object({ verdicts: z.array(verifierVerdict) });

// ---- analyzer ----
export const moduleSummary = z.object({
  purpose: z.string().describe('What this module is for, 1 to 2 sentences'),
  keyFiles: z.array(z.object({ path: z.string(), role: z.string() })).describe('Up to 5 important files and what each does'),
  conventions: z.array(z.string()).describe('Patterns this code consistently follows, each with a file as evidence. Up to 6'),
  reviewFocus: z.array(z.string()).describe('What a reviewer should check when this module changes. Up to 6, specific to this code'),
});
export const ruleProposal = z.object({
  rules: z.array(
    z.object({
      id: z.string().describe('Short id like NEXT-001, SEC-001, TS-001, GEN-001'),
      section: z.string().describe('Section heading, e.g. "Security" or "Next.js"'),
      appliesTo: z.array(z.string()).describe('Glob patterns the rule applies to; empty list for all files'),
      text: z.string().describe('The rule, one sentence, phrased so a violation can be pointed at on a changed line'),
      why: z.string().describe('Evidence from this project for the rule (file, config or convention)'),
    }),
  ),
});
export type ModuleSummary = z.infer<typeof moduleSummary>;
export type RuleProposal = z.infer<typeof ruleProposal>;

export type Severity = z.infer<typeof severity>;
export type Category = z.infer<typeof category>;
export type ReviewerFinding = z.infer<typeof reviewerFinding>;

/** A finding after it has been located, verified and given an id. This is what gets published. */
export interface Finding extends ReviewerFinding {
  id: string;
  path: string;
  ruleText: string;
  ruleSource: string;
  verifierReason?: string;
}
