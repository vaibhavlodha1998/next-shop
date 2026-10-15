// In-memory stand-in for the parts of the GitHub REST API the reviewer uses.
// Offline tests only:  node test/mock-github.mjs <port> <repoRoot> <pr-fixture.json...>
// repoRoot is the default branch on disk. Each PR fixture is
//   { number, head, base, files: [{ filename, status, additions, deletions, patch }], headFiles: { path: content } }
// GET /__state returns everything that was "posted", for assertions.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [port, repoRoot, ...fixtureFiles] = process.argv.slice(2);
process.on('uncaughtException', (e) => console.error('MOCK CRASH', e));
const prs = new Map();
for (const f of fixtureFiles) {
  const fx = JSON.parse(fs.readFileSync(f, 'utf8'));
  prs.set(fx.number, {
    number: fx.number, state: 'open', user: { login: 'dev' }, head: { sha: fx.head, repo: { full_name: 'acme/demo' } }, base: { sha: fx.base, ref: 'main' },
    files: fx.files, headFiles: fx.headFiles ?? {},
  });
}
const S = {
  statuses: [], labels: new Set(), issues: [], issueComments: [], reviews: [], reviewComments: [], reactions: [], prLabels: {},
  trees: [], commits: [], refs: {}, pulls: [], forbidPr: false,
};
let nextId = 1000;
const now = () => new Date().toISOString();
const bot = { login: 'github-actions[bot]', type: 'Bot' };
const perms = { dev: 'write', owner: 'admin', acme: 'admin', lead: 'maintain', stranger: 'read' };

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? {}));
}
function fileAt(rel, ref) {
  for (const pr of prs.values()) if (pr.head.sha === ref && rel in pr.headFiles) return pr.headFiles[rel];
  const fp = path.join(repoRoot, rel);
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return null;
  let text = fs.readFileSync(fp, 'utf8');
  if (rel === '.ai-review/config.yml') {
    if (process.env.MOCK_FAST === '1') text = text.replace(/minIntervalMs: \d+/, 'minIntervalMs: 0');
    if (process.env.MOCK_MODE) text = text.replace(/^mode: \w+/m, `mode: ${process.env.MOCK_MODE}`);
  }
  return text;
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname.replace(/^\/repos\/acme\/demo/, '');
      const body = raw ? JSON.parse(raw) : {};
      const m = (re) => p.match(re);
      const page2 = u.searchParams.get('page') > 1;
      let x;
      if (p === '/__state') return send(res, 200, { ...S, labels: [...S.labels] });
      if (p === '/__set-head' && req.method === 'POST') { prs.get(body.pr).head.sha = body.sha; return send(res, 200, {}); }
      if (p === '/__forbid-pr' && req.method === 'POST') { S.forbidPr = body.value; return send(res, 200, {}); }

      // ---- repo, branches, git data (analyze) ----
      if (p === '' && req.method === 'GET') return send(res, 200, { full_name: 'acme/demo', default_branch: 'main' });
      if ((x = m(/^\/branches\/([^/]+)$/))) return send(res, 200, { name: x[1], commit: { sha: 'b'.repeat(40), commit: { tree: { sha: 't'.repeat(40) } } } });
      if (p === '/git/trees' && req.method === 'POST') { const t = { sha: `tree${nextId++}`, ...body }; S.trees.push(t); return send(res, 201, t); }
      if (p === '/git/commits' && req.method === 'POST') { const c = { sha: `commit${nextId++}`, ...body }; S.commits.push(c); return send(res, 201, c); }
      if ((x = m(/^\/git\/refs\/(.+)$/)) && req.method === 'PATCH') {
        if (!(x[1] in S.refs)) return send(res, 422, { message: 'Reference does not exist' });
        S.refs[x[1]] = body.sha;
        return send(res, 200, { ref: x[1], object: { sha: body.sha } });
      }
      if (p === '/git/refs' && req.method === 'POST') { S.refs[body.ref.replace(/^refs\//, '')] = body.sha; return send(res, 201, { ref: body.ref }); }
      if (p === '/pulls' && req.method === 'GET') {
        const head = u.searchParams.get('head')?.split(':')[1];
        return send(res, 200, page2 ? [] : S.pulls.filter((q) => q.state === 'open' && (!head || q.head === head)));
      }
      if (p === '/pulls' && req.method === 'POST') {
        if (S.forbidPr) return send(res, 403, { message: 'GitHub Actions is not permitted to create or approve pull requests.' });
        const pr = { number: nextId++, state: 'open', ...body, html_url: `https://github.com/acme/demo/pull/${nextId - 1}` };
        S.pulls.push(pr);
        return send(res, 201, pr);
      }
      if ((x = m(/^\/pulls\/(\d+)$/)) && req.method === 'PATCH') {
        const pr = S.pulls.find((q) => q.number === Number(x[1]));
        Object.assign(pr, body);
        return send(res, 200, pr);
      }

      // ---- pull requests (review) ----
      if ((x = m(/^\/pulls\/(\d+)$/)) && req.method === 'GET') {
        const pr = prs.get(Number(x[1]));
        return pr ? send(res, 200, { ...pr, files: undefined, headFiles: undefined }) : send(res, 404, { message: 'Not Found' });
      }
      if ((x = m(/^\/pulls\/(\d+)\/files$/))) return send(res, 200, page2 ? [] : prs.get(Number(x[1])).files);
      if ((x = m(/^\/contents\/(.+)$/))) {
        const text = fileAt(decodeURIComponent(x[1]), u.searchParams.get('ref'));
        return text == null ? send(res, 404, { message: 'Not Found' }) : send(res, 200, { type: 'file', content: Buffer.from(text).toString('base64') });
      }
      if ((x = m(/^\/statuses\/(\w+)$/))) { S.statuses.push({ sha: x[1], ...body }); return send(res, 201, body); }
      if (p === '/labels') { if (S.labels.has(body.name)) return send(res, 422, { message: 'exists' }); S.labels.add(body.name); return send(res, 201, body); }
      if ((x = m(/^\/collaborators\/([^/]+)\/permission$/))) return send(res, 200, { permission: perms[x[1]] ?? 'none' });

      if (p === '/issues' && req.method === 'GET') {
        const want = u.searchParams.get('labels');
        const st = u.searchParams.get('state');
        return send(res, 200, page2 ? [] : S.issues.filter((i) => (!want || i.labels.some((l) => l.name === want)) && (!st || i.state === st)));
      }
      if (p === '/issues' && req.method === 'POST') {
        const issue = { number: nextId++, title: body.title, body: body.body, state: 'open', labels: (body.labels ?? []).map((n) => ({ name: n })), assignees: [], html_url: `https://github.com/acme/demo/issues/${nextId - 1}`, user: bot };
        S.issues.push(issue);
        return send(res, 201, issue);
      }
      if ((x = m(/^\/issues\/(\d+)$/)) && req.method === 'PATCH') {
        const i = S.issues.find((i) => i.number === Number(x[1]));
        Object.assign(i, body);
        return send(res, 200, i);
      }
      if ((x = m(/^\/issues\/(\d+)\/comments$/))) {
        const c = { id: nextId++, issue: Number(x[1]), body: body.body, user: bot, html_url: `https://github.com/acme/demo/issues/${x[1]}#c${nextId - 1}` };
        S.issueComments.push(c);
        return send(res, 201, c);
      }
      if ((x = m(/^\/issues\/(\d+)\/labels$/))) {
        const n = Number(x[1]);
        const i = S.issues.find((i) => i.number === n);
        if (i) i.labels.push(...body.labels.map((name) => ({ name })));
        else S.prLabels[n] = [...(S.prLabels[n] ?? []), ...body.labels];
        return send(res, 200, []);
      }
      if ((x = m(/^\/issues\/(\d+)\/assignees$/))) { const i = S.issues.find((i) => i.number === Number(x[1])); i.assignees = body.assignees; return send(res, 201, i); }

      if ((x = m(/^\/pulls\/(\d+)\/reviews$/))) {
        const pr = prs.get(Number(x[1]));
        const patches = new Map(pr.files.map((f) => [f.filename, f.patch]));
        for (const c of body.comments ?? []) if (!patches.has(c.path)) return send(res, 422, { message: `path ${c.path} not in diff` });
        const review = { id: nextId++, pr: pr.number, commit_id: body.commit_id, event: body.event, body: body.body, html_url: `https://github.com/acme/demo/pull/${pr.number}#review` };
        S.reviews.push(review);
        for (const c of body.comments ?? [])
          S.reviewComments.push({ id: nextId++, pr: pr.number, path: c.path, line: c.line, side: c.side, body: c.body, user: bot, in_reply_to_id: undefined, diff_hunk: patches.get(c.path), created_at: now(), reactions: { '+1': 1, '-1': 0 }, html_url: `https://github.com/acme/demo/pull/${pr.number}#discussion_r${nextId - 1}` });
        return send(res, 200, review);
      }
      if ((x = m(/^\/pulls\/comments\/(\d+)$/))) {
        const c = S.reviewComments.find((c) => c.id === Number(x[1]));
        return c ? send(res, 200, c) : send(res, 404, { message: 'Not Found' });
      }
      if (p === '/pulls/comments') return send(res, 200, page2 ? [] : S.reviewComments);
      if ((x = m(/^\/pulls\/(\d+)\/comments$/)) && req.method === 'GET') return send(res, 200, page2 ? [] : S.reviewComments.filter((c) => c.pr === Number(x[1])));
      if ((x = m(/^\/pulls\/(\d+)\/comments\/(\d+)\/replies$/))) {
        const c = { id: nextId++, pr: Number(x[1]), body: body.body, user: bot, in_reply_to_id: Number(x[2]), created_at: now(), html_url: `https://github.com/acme/demo/pull/${x[1]}#discussion_r${nextId - 1}` };
        S.reviewComments.push(c);
        return send(res, 201, c);
      }
      if (p === '/__human-reply' && req.method === 'POST') {
        const c = { id: nextId++, pr: body.pr, body: body.body, user: { login: body.user, type: 'User' }, in_reply_to_id: body.in_reply_to_id, created_at: now(), html_url: `https://github.com/acme/demo/pull/${body.pr}#discussion_r${nextId - 1}` };
        S.reviewComments.push(c);
        return send(res, 201, c);
      }
      if ((x = m(/^\/(issues|pulls)\/comments\/(\d+)\/reactions$/))) { S.reactions.push({ comment: Number(x[2]), content: body.content }); return send(res, 201, body); }

      console.error('UNHANDLED', req.method, req.url);
      send(res, 404, { message: `mock: no route for ${req.method} ${p}` });
    });
  })
  // Long keep-alive: the test client reuses sockets across slow steps.
  .on('listening', function () {
    this.keepAliveTimeout = 120_000;
  })
  .listen(Number(port), '127.0.0.1', () => console.log(`mock GitHub on http://127.0.0.1:${port}`));
