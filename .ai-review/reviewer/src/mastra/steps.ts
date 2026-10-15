import type { Processor } from '@mastra/core/processors';
import { INPUT_TOKEN_BUDGET, estimateTokens } from './models';

/**
 * Pacing and step control, as Mastra processors that run before EVERY model request
 * (including each step of a tool loop):
 *
 *   RatePacer      spaces all requests in this process by a minimum gap, so a tool loop
 *                  cannot burst past the provider's requests-per-minute limit.
 *   StepControl    lets the agent call tools for `maxToolSteps` steps, then switches tools off
 *                  (toolChoice: none) so the next step must be the final answer. It also stops
 *                  exploring early if the conversation is getting close to the token cap.
 */
let gapMs = 0;
let last = 0;
let requests = 0;

export const setPace = (ms: number) => (gapMs = ms);
export const modelRequests = () => requests;

export class RatePacer implements Processor<'rate-pacer'> {
  readonly id = 'rate-pacer' as const;
  readonly name = 'Rate pacer';
  async processInputStep() {
    const wait = last + gapMs - Date.now();
    last = Math.max(Date.now(), last + gapMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    requests++;
    return undefined;
  }
}

export class StepControl implements Processor<'step-control'> {
  readonly id = 'step-control' as const;
  readonly name = 'Step control';
  steps = 0;
  forced = false;
  constructor(private readonly maxToolSteps: number) {}

  processInputStep({ stepNumber, messages, systemMessages }: { stepNumber: number; messages: unknown[]; systemMessages: unknown[] }) {
    this.steps = stepNumber + 1;
    const size = estimateTokens(JSON.stringify(messages)) + estimateTokens(JSON.stringify(systemMessages ?? []));
    if (stepNumber >= this.maxToolSteps || size > INPUT_TOKEN_BUDGET * 0.92) {
      this.forced = stepNumber > 0;
      return { toolChoice: 'none' as const };
    }
    return undefined;
  }
}
