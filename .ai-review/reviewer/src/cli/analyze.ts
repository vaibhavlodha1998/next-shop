/**
 * Entry point for `ai-review analyze`.
 *   CI (ai-review-analyze workflow):  npx tsx src/cli/analyze.ts            opens or updates a PR
 *   Local:                            npm run analyze -- --write            writes the files into your repo
 *                                     npm run analyze -- --print            prints them only
 */
import path from 'node:path';
import { readEvent, gh, repoRef, permissionOf } from '../lib/github';
import { runAnalyze } from '../analyze/run';

async function main() {
  const args = process.argv.slice(2);
  const deliver = args.includes('--write') ? 'write' : args.includes('--print') ? 'print' : 'pr';
  const root = process.env.REPO_ROOT || process.env.GITHUB_WORKSPACE || path.resolve(process.cwd(), '..', '..');
  const { name, payload } = readEvent<any>();

  let replyTo: number | undefined;
  let trigger = name || 'manual';
  if (name === 'issue_comment') {
    const actor = payload.comment?.user?.login;
    replyTo = payload.issue?.number;
    trigger = `/ai-review analyze by @${actor}`;
    const perm = await permissionOf(gh(), repoRef(), actor);
    if (!['admin', 'maintain', 'write'].includes(perm)) {
      await gh().issues.createComment({ ...repoRef(), issue_number: replyTo!, body: `@${actor} only people with write access can run \`/ai-review analyze\`.` });
      return;
    }
  }

  const { outcome, link } = await runAnalyze({ root, deliver, trigger, replyTo });
  console.log(`outcome: ${outcome}${link ? ` ${link}` : ''}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
