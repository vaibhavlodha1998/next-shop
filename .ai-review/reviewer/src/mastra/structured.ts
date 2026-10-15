import type { Agent } from '@mastra/core/agent';
import type { z } from 'zod';
import { jsonMode } from './models';

/**
 * Structured generation with a safety net: use the provider's native json_schema
 * response format, and if the provider rejects it (some OpenAI-compatible endpoints
 * do), switch to Mastra's prompt-injected JSON for the rest of the run.
 */
let usePrompt = jsonMode() === 'prompt';

export async function generateStructured<T extends z.ZodType>(
  agent: Agent<any, any, any>,
  prompt: string,
  schema: T,
  modelSettings: { temperature?: number; maxOutputTokens?: number },
  /** Extra execution options, e.g. tools, maxSteps, requestContext, per-call processors (tool mode). */
  extra: Record<string, unknown> = {},
): Promise<z.infer<T>> {
  const call = (prompted: boolean) =>
    agent.generate(prompt, {
      ...extra,
      structuredOutput: { schema, ...(prompted ? { jsonPromptInjection: true as const } : {}) },
      modelSettings,
    } as any);
  const triedPrompted = usePrompt; // the mode THIS call used (another call may flip the flag meanwhile)
  let res;
  try {
    res = await call(triedPrompted);
  } catch (e: any) {
    if (triedPrompted || !/response_format|json_schema|structured output|schema/i.test(String(e?.message ?? e))) throw e;
    if (!usePrompt) console.warn(`Provider rejected native structured output, switching to prompt-injected JSON: ${e.message}`);
    usePrompt = true;
    res = await call(true);
  }
  if (res.tripwire) throw new Error(`guardrail stopped the call: ${res.tripwire.reason}`);
  if (!res.object) throw new Error(`${agent.name} returned no structured output`);
  return res.object as z.infer<T>;
}
