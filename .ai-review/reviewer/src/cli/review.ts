/**
 * Entry point for the `ai-review` workflow (pull_request events).
 *   npx tsx src/cli/review.ts            # reads the PR number from the Actions event
 *   npx tsx src/cli/review.ts --pr 12    # explicit
 */
import { readEvent } from '../lib/github';
import { runReview } from '../pipeline/run';

const argPr = process.argv.indexOf('--pr');
const { payload } = readEvent();
const pr = Number(argPr > -1 ? process.argv[argPr + 1] : process.env.PR_NUMBER || payload?.pull_request?.number);

if (!pr) {
  console.error('No PR number: pass --pr N, set PR_NUMBER, or run from a pull_request event.');
  process.exit(2);
}

runReview({ pr, trigger: process.env.GITHUB_EVENT_NAME || 'manual' })
  .then(({ outcome }) => {
    console.log(`outcome: ${outcome}`);
    process.exit(outcome === 'model-error' ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
