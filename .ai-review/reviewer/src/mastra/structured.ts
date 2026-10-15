import type { Agent } from '@mastra/core/agent';
import type { z } from 'zod';
import { jsonMode } from './models';

/**
 * Structured generation that adapts to what the provider accepts.
 *
 * Some OpenAI-compatible gateways reject certain request shapes, sometimes loudly (400 about
 * response_format) and sometimes oddly (GitHub Models has answered 200 with a plain-text "OK" when a
 * request carried tools AND a json_schema response format). So each request shape is tried in order,
 * and a shape that fails with such an error is skipped for the rest of the run:
 *
 *   with tools:     native json_schema  ->  JSON described in the prompt
 *   without tools:  native json_schema  ->  JSON described in the prompt
 *
 * If every tool shape fails, the caller (review.ts) drops tools and retries in single-call mode.
 */
type Shape = 'native' | 'prompt';
const failed = new Set<string>(); // "tools:native", "plain:prompt", ...
const notes: string[] = [];
if (jsonMode() === 'prompt') failed.add('tools:native').add('plain:native');

export const compatNotes = () => [...notes];

/** Errors that mean "the provider does not accept this request shape", as opposed to rate limits or outages. */
export function isCompatError(e: unknown): boolean {
  const err = e as { message?: string; statusCode?: number; responseBody?: string; cause?: unknown };
  const text = `${err?.message ?? ''} ${err?.responseBody ?? ''} ${String((err?.cause as any)?.message ?? '')}`;
  if (err?.statusCode === 429 || /rate limit|too many requests/i.test(text)) return false;
  return (
    /response_format|json_schema|structured output|Invalid JSON response|JSON parsing failed|not valid JSON|tool(s|_choice)? (is|are)? ?not supported/i.test(text) ||
    [400, 415, 422].includes(err?.statusCode ?? 0)
  );
}

export class ShapeUnsupported extends Error {
  constructor(readonly kind: 'tools' | 'plain', cause: unknown) {
    super(`provider rejected every ${kind} request shape: ${(cause as Error)?.message ?? cause}`);
  }
}

export async function generateStructured<T extends z.ZodType>(
  agent: Agent<any, any, any>,
  prompt: string,
  schema: T,
  modelSettings: { temperature?: number; maxOutputTokens?: number },
  /** Extra execution options, e.g. tools, maxSteps, requestContext, per-call processors (tool mode). */
  extra: Record<string, unknown> = {},
): Promise<z.infer<T>> {
  const kind = extra.toolsets ? 'tools' : 'plain';
  let lastError: unknown;
  for (const shape of ['native', 'prompt'] as Shape[]) {
    const key = `${kind}:${shape}`;
    if (failed.has(key)) continue;
    let res;
    try {
      res = await agent.generate(prompt, {
        ...extra,
        structuredOutput: { schema, ...(shape === 'prompt' ? { jsonPromptInjection: true as const } : {}) },
        modelSettings,
      } as any);
    } catch (e) {
      if (!isCompatError(e)) throw e;
      lastError = e;
      if (!failed.has(key)) {
        failed.add(key);
        notes.push(`Provider rejected ${kind === 'tools' ? 'tool calls with' : 'requests with'} ${shape === 'native' ? 'a json_schema response format' : 'prompt-described JSON'} (${(e as Error).message}); switched shape for the rest of the run`);
      }
      continue;
    }
    if (res.tripwire) throw new Error(`guardrail stopped the call: ${res.tripwire.reason}`);
    if (!res.object) throw new Error(`${agent.name} returned no structured output`);
    return res.object as z.infer<T>;
  }
  throw new ShapeUnsupported(kind, lastError);
}

/** True once tool requests have failed in every shape this run, so callers can skip straight to single-call mode. */
export const toolsUnsupported = () => failed.has('tools:native') && failed.has('tools:prompt');
