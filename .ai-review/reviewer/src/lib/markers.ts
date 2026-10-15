import zlib from 'node:zlib';

/**
 * Hidden state carried inside GitHub comments and issue bodies as HTML comments.
 * This is how the POC stays serverless: the drafts issue IS the queue, and each
 * published comment carries the finding it came from (for the Responder and the digest).
 */
const enc = (v: unknown) => zlib.deflateRawSync(Buffer.from(JSON.stringify(v))).toString('base64url');
const dec = <T>(s: string): T => JSON.parse(zlib.inflateRawSync(Buffer.from(s, 'base64url')).toString('utf8'));

export const marker = (kind: string, value: unknown) => `<!-- ai-review:${kind}:${enc(value)} -->`;

export function readMarker<T>(body: string | null | undefined, kind: string): T | null {
  const m = body?.match(new RegExp(`<!-- ai-review:${kind}:([A-Za-z0-9_-]+) -->`));
  if (!m) return null;
  try {
    return dec<T>(m[1]);
  } catch {
    return null;
  }
}
