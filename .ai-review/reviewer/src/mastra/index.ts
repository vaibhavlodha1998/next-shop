import { Mastra } from '@mastra/core/mastra';
import { reviewerAgent } from './agents/reviewer';
import { verifierAgent } from './agents/verifier';
import { responderAgent } from './agents/responder';
import { analystAgent, ruleWriterAgent } from './agents/analyst';

// Registered so `npm run dev` (Mastra playground) can be used to poke at each agent locally.
// The CI entry points in src/cli use the same agent instances directly.
export const mastra = new Mastra({
  agents: { reviewerAgent, verifierAgent, responderAgent, analystAgent, ruleWriterAgent },
});
