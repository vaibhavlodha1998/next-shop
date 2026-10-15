import type { MastraModelConfig } from '@mastra/core/llm';
import type { ModelWithRetries } from '@mastra/core/agent';

/**
 * Model wiring. Defaults to GitHub Models (free tier, OpenAI-compatible),
 * authenticated with the GITHUB_TOKEN that Actions injects.
 *
 * Swap providers with env vars only, no code change:
 *   LLM_BASE_URL   default https://models.github.ai/inference
 *   LLM_API_KEY    default $GITHUB_TOKEN
 *   REVIEWER_MODEL default openai/gpt-4.1        (large model, "High" tier: 10 rpm, 50/day)
 *   VERIFIER_MODEL default openai/gpt-4.1-mini   (fast model,  "Low" tier: 15 rpm, 150/day)
 *   RESPONDER_MODEL default = REVIEWER_MODEL
 *   ANALYST_MODEL  default = VERIFIER_MODEL (one call per module when analysing the project)
 *
 * Groq example: LLM_BASE_URL=https://api.groq.com/openai/v1, LLM_API_KEY=$GROQ_API_KEY,
 * REVIEWER_MODEL=llama-3.3-70b-versatile.
 */
export const DEFAULT_BASE_URL = 'https://models.github.ai/inference';

export function llmBaseUrl(): string {
  return (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function apiKey(): string {
  return process.env.LLM_API_KEY || process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN || '';
}

function model(modelId: string): MastraModelConfig {
  return { providerId: 'llm', modelId, url: llmBaseUrl(), apiKey: apiKey() };
}

export const modelIds = {
  reviewer: () => process.env.REVIEWER_MODEL || 'openai/gpt-4.1',
  verifier: () => process.env.VERIFIER_MODEL || 'openai/gpt-4.1-mini',
  responder: () => process.env.RESPONDER_MODEL || process.env.REVIEWER_MODEL || 'openai/gpt-4.1',
  analyst: () => process.env.ANALYST_MODEL || process.env.VERIFIER_MODEL || 'openai/gpt-4.1-mini',
};

/**
 * Fallback chain (Mastra model fallbacks): if the primary model errors, for example a model the provider no
 * longer serves properly, the same request goes to FALLBACK_MODEL (default: the verifier model, gpt-4.1-mini).
 * Set FALLBACK_MODEL=none to disable.
 */
export const fallbackModelId = () => {
  const v = process.env.FALLBACK_MODEL || modelIds.verifier();
  return v === 'none' ? null : v;
};
function chain(id: string): MastraModelConfig | ModelWithRetries[] {
  const fb = fallbackModelId();
  if (!fb || fb === id) return model(id);
  return [
    { id: 'primary', model: model(id), maxRetries: 1 },
    { id: 'fallback', model: model(fb), maxRetries: 2 },
  ];
}

// Resolved per call so env changes (tests, CLI flags) are honoured.
export const reviewerModel = () => chain(modelIds.reviewer());
export const verifierModel = () => model(modelIds.verifier());
export const responderModel = () => chain(modelIds.responder());
export const analystModel = () => chain(modelIds.analyst());

/** GitHub Models free tier caps every request at 8000 input tokens. Keep a margin. */
export const INPUT_TOKEN_BUDGET = Number(process.env.LLM_INPUT_TOKEN_BUDGET || 7000);
export const OUTPUT_TOKEN_LIMIT = Number(process.env.LLM_OUTPUT_TOKEN_LIMIT || 2500);

/** Rough token estimate (code averages ~3.2 chars per token). Deliberately pessimistic. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.2);

/** 'native' uses response_format json_schema; 'prompt' injects the schema (for providers without it). */
export const jsonMode = (): 'native' | 'prompt' => (process.env.LLM_JSON_MODE === 'prompt' ? 'prompt' : 'native');
