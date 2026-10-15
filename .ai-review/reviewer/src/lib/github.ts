import fs from 'node:fs';
import { Octokit } from '@octokit/rest';

export interface RepoRef {
  owner: string;
  repo: string;
}

export function gh(): Octokit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  // Expected 404/422 responses (missing file, label already exists) are handled in code, so keep them out of the log.
  const quiet = (msg: string) => !/ - (404|422) /.test(msg);
  return new Octokit({
    auth: token,
    baseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    userAgent: 'ai-pr-reviewer-poc',
    log: { debug: () => {}, info: () => {}, warn: (m: string) => quiet(m) && console.warn(m), error: (m: string) => quiet(m) && console.error(m) },
  });
}

export function repoRef(): RepoRef {
  const full = process.env.GITHUB_REPOSITORY;
  if (!full || !full.includes('/')) throw new Error('GITHUB_REPOSITORY must be set as owner/repo');
  const [owner, repo] = full.split('/');
  return { owner, repo };
}

export function readEvent<T = any>(): { name: string; payload: T } {
  const p = process.env.GITHUB_EVENT_PATH;
  return { name: process.env.GITHUB_EVENT_NAME || '', payload: p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : ({} as T) };
}

export async function ensureLabel(o: Octokit, r: RepoRef, name: string, color: string, description = '') {
  try {
    await o.issues.createLabel({ ...r, name, color, description });
  } catch (e: any) {
    if (e.status !== 422) throw e; // 422 = already exists
  }
}

export async function setStatus(o: Octokit, r: RepoRef, sha: string, state: 'pending' | 'success' | 'failure' | 'error', description: string, targetUrl?: string) {
  try {
    await o.repos.createCommitStatus({ ...r, sha, state, context: 'ai-review', description: description.slice(0, 140), target_url: targetUrl });
  } catch (e: any) {
    console.warn(`Could not set commit status: ${e.message}`);
  }
}

export async function permissionOf(o: Octokit, r: RepoRef, username: string): Promise<string> {
  try {
    const { data } = await o.repos.getCollaboratorPermissionLevel({ ...r, username });
    return data.permission; // admin | maintain | write | triage | read | none
  } catch {
    return 'none';
  }
}

/** Reads a text file from the repo at an exact commit (used for rules and config, always at the BASE commit). */
export async function readRepoFile(o: Octokit, r: RepoRef, filePath: string, ref: string): Promise<string | null> {
  try {
    const { data } = await o.repos.getContent({ ...r, path: filePath, ref });
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (e: any) {
    if (e.status === 404) return null;
    throw e;
  }
}

export const runUrl = () =>
  process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
