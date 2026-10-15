// Local stand-in for an OpenAI-compatible endpoint (GitHub Models, Groq, ...).
// Used for offline tests: `node test/mock-llm.mjs 4010`, then set
// LLM_BASE_URL=http://127.0.0.1:4010 and run the CLIs.
// It answers based on which agent is calling (detected from the system prompt).
import http from 'node:http';

const port = Number(process.argv[2] ?? 4010);
const log = [];

function reply(res, content, model) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'mock-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
  );
}

function allText(messages) {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('')))
    .join('\n');
}

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/__log') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(log));
      }
      const json = body ? JSON.parse(body) : {};
      const text = allText(json.messages ?? []);
      if (process.env.MOCK_REJECT_SCHEMA === '1' && json.response_format?.type === 'json_schema') {
        log.push({ path: req.url, model: json.model, rejected: true, prompt: '' });
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.", type: 'invalid_request_error' } }));
      }
      log.push({ path: req.url, model: json.model, auth: req.headers.authorization ? 'set' : 'missing', response_format: json.response_format?.type, chars: body.length, prompt: text });

      if (text.includes('ROLE: REVIEWER')) {
        // Pick the first added line number from the numbered diff, plus one bogus finding the verifier must drop.
        const m = text.match(/^\+\s*(\d+) \|/m);
        const line = m ? Number(m[1]) : 1;
        const rule = (text.match(/\[([A-Z]+-\d+)\]/) ?? [])[1] ?? 'GEN-001';
        // SQL built by concatenation in the diff -> a critical security finding (exercises the escalation path).
        const sql = process.env.MOCK_NO_CRITICAL === '1' ? null : text.match(/^\+\s*(\d+) \|.*SELECT .*(" \+|\$\{)/m);
        const first = sql
          ? { ruleId: 'SEC-001', line: Number(sql[1]), severity: 'critical', category: 'security', title: 'SQL built by concatenation', message: 'The id is concatenated into SQL.', suggestion: null, confidence: 0.95 }
          : { ruleId: rule, line, severity: 'major', category: 'correctness', title: 'Mock finding', message: `Line ${line} breaks ${rule}.`, suggestion: null, confidence: 0.9 };
        return reply(
          res,
          JSON.stringify({
            findings: [
              first,
              { ruleId: 'NOPE-999', line: 99999, severity: 'minor', category: 'style', title: 'Uncited finding', message: 'Should be dropped.', suggestion: null, confidence: 0.4 },
            ],
          }),
          json.model,
        );
      }
      if (text.includes('ROLE: ANALYST')) {
        const mod = (text.match(/^MODULE: (.+?) \(/m) ?? [])[1] ?? 'module';
        const first = (text.match(/^===== (.+)$/m) ?? [])[1] ?? 'unknown';
        return reply(
          res,
          JSON.stringify({
            purpose: `Mock purpose for ${mod}.`,
            keyFiles: [{ path: first, role: 'entry point' }],
            conventions: [`Mock convention seen in ${first}`],
            reviewFocus: [`Mock check for changes in ${mod}`],
          }),
          json.model,
        );
      }
      if (text.includes('ROLE: RULE WRITER')) {
        return reply(
          res,
          JSON.stringify({
            rules: [
              { id: 'SEC-001', section: 'Security', appliesTo: [], text: 'Never build SQL from string concatenation.', why: 'mock' },
              { id: 'NEXT-001', section: 'Next.js', appliesTo: ['src/app/**/actions.ts', 'src/app/**/route.ts'], text: 'Authenticate and authorise inside every Server Action and route handler.', why: 'src/app/cart/actions.ts does this' },
              { id: 'TS-001', section: 'TypeScript', appliesTo: ['**/*.ts', '**/*.tsx'], text: 'No `any` in exported function signatures.', why: 'strict mode on' },
            ],
          }),
          json.model,
        );
      }
      if (text.includes('ROLE: VERIFIER')) {
        const ids = [...text.matchAll(/"id":\s*"(F\d+)"/g)].map((x) => x[1]);
        return reply(res, JSON.stringify({ verdicts: ids.map((id) => ({ id, keep: true, severity: null, reason: 'Supported by the diff.' })) }), json.model);
      }
      return reply(res, 'Mock responder answer: the rule exists because consistency matters. Example:\n```ts\nconst x = 1;\n```', json.model);
    });
  })
  // Long keep-alive: the test client reuses sockets across slow steps.
  .on('listening', function () {
    this.keepAliveTimeout = 120_000;
  })
  .listen(port, '127.0.0.1', () => console.log(`mock LLM on http://127.0.0.1:${port}`));
