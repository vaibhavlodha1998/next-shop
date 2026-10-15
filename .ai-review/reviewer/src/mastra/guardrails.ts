import type { Processor } from '@mastra/core/processors';
import { RegexFilterProcessor } from '@mastra/core/processors';
import { INPUT_TOKEN_BUDGET, estimateTokens } from './models';

/**
 * Mastra guardrails shared by all agents. All of them are deterministic, so they
 * cost no extra model calls (important on the free tier).
 *
 * 1. Secret redaction on input and output (defence in depth; Gitleaks already
 *    stopped the run if the diff held a secret).
 * 2. Prompt-injection markers in the code are logged; the prompts also tell the
 *    model that everything inside <diff> is untrusted data.
 * 3. A hard per-request token budget, so a request never exceeds the provider cap
 *    (GitHub Models free tier: 8000 input tokens) and never burns quota by accident.
 */

export const secretRedactor = () =>
  new RegexFilterProcessor({ presets: ['secrets'], strategy: 'redact', phase: 'all' });

export const injectionWatch = () =>
  new RegexFilterProcessor({
    strategy: 'warn',
    phase: 'input',
    rules: [
      { name: 'ignore-instructions', pattern: /ignore (all )?(previous|prior|above) (instructions|rules)/gi },
      { name: 'role-override', pattern: /you are now (a|an|the) /gi },
      { name: 'approve-request', pattern: /(approve|lgtm) this (pr|mr|merge request|pull request)/gi },
    ],
  });

export class TokenBudgetGuard implements Processor<'token-budget-guard'> {
  readonly id = 'token-budget-guard' as const;
  readonly name = 'Token budget guard';
  constructor(private readonly budget = INPUT_TOKEN_BUDGET) {}

  processInput({ messages, systemMessages, abort }: Parameters<NonNullable<Processor['processInput']>>[0]) {
    const size = estimateTokens(JSON.stringify(messages)) + estimateTokens(JSON.stringify(systemMessages ?? []));
    if (size > this.budget * 1.15) {
      abort(`Request is about ${size} tokens, over the ${this.budget} token budget`);
    }
    return messages;
  }
}

export const inputGuardrails = () => [new TokenBudgetGuard(), injectionWatch(), secretRedactor()];
export const outputGuardrails = () => [secretRedactor()];
