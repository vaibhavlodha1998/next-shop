import fs from 'node:fs';
import path from 'node:path';

/**
 * Step 10, Record. A full trace of the run as JSON (uploaded as a workflow artifact)
 * plus a readable job summary. Never contains code or secret values: only paths,
 * line numbers, rule ids and finding text.
 */
export function outDir() {
  const d = path.resolve(process.env.AI_REVIEW_OUT || '.ai-review-out');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function writeRecord(name: string, record: Record<string, unknown>, summaryMd: string) {
  const file = path.join(outDir(), `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...record, recordedAt: new Date().toISOString() }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd + '\n');
  console.log(summaryMd);
  return file;
}
