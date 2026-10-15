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
      // Reproduces GitHub Models answering 200 with a plain-text "OK" for request shapes it does not accept.
      //   MOCK_OK_IF=tools+schema | tools | schema
      const hasTools = (json.tools ?? []).length > 0;
      const hasSchema = json.response_format?.type === 'json_schema';
      const okIf = process.env.MOCK_OK_IF;
      if ((okIf === 'tools+schema' && hasTools && hasSchema) || (okIf === 'tools' && hasTools) || (okIf === 'schema' && hasSchema)) {
        log.push({ path: req.url, model: json.model, broken: true, shape: `${hasTools ? 'tools' : 'plain'}+${hasSchema ? 'schema' : 'prompt'}`, prompt: '', tools: [], toolResults: [] });
        res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
        return res.end('OK\r\n');
      }
      // Reproduces a provider that answers 200 with a plain-text "OK" for a model it no longer serves properly.
      if (process.env.MOCK_BROKEN_MODEL && json.model === process.env.MOCK_BROKEN_MODEL) {
        log.push({ path: req.url, model: json.model, broken: true, prompt: '', tools: [], toolResults: [] });
        res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
        return res.end('OK\r\n');
      }
      const text = allText(json.messages ?? []);
      if (process.env.MOCK_REJECT_SCHEMA === '1' && json.response_format?.type === 'json_schema') {
        log.push({ path: req.url, model: json.model, rejected: true, prompt: '' });
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.", type: 'invalid_request_error' } }));
      }
      const toolNames = (json.tools ?? []).map((t) => t.function?.name);
      const toolMsgs = (json.messages ?? []).filter((m) => m.role === 'tool');
      log.push({
        path: req.url, model: json.model, auth: req.headers.authorization ? 'set' : 'missing', response_format: json.response_format?.type,
        chars: body.length, prompt: text, tools: toolNames, toolChoice: json.tool_choice, toolResults: toolMsgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
      });

      // Tool mode. The Reviewer keeps exploring (load a skill, read files, find usages) until tools are switched off;
      // the Responder reads one file, then answers. This exercises the step cap and forced final answer.
      const rounds = (json.messages ?? []).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
      const toolCall = (calls) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'mock-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: json.model,
          choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: calls.map(([name, args], i) => ({ id: `call_${rounds}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }));
      };
      if (text.includes('ROLE: REVIEWER') && toolNames.includes('read_file') && json.tool_choice !== 'none' && rounds < 5) {
        const skill = (text.match(/<name>([a-z-]+-review)<\/name>/) ?? [])[1];
        const calls = [];
        if (rounds === 0 && skill && toolNames.includes('skill')) calls.push(['skill', { name: skill }]);
        const file = (text.match(/^FILE: (\S+)/m) ?? [])[1] ?? '';
        // Read the reviewed file itself when it is the legacy one (secret masking check), else a helper it depends on.
        if (rounds === 0) calls.push(['read_file', { path: file.endsWith('legacy.ts') ? file : 'src/lib/auth.ts', startLine: null, endLine: null }]);
        if (rounds === 0) calls.push(['read_file', { path: '.env.local', startLine: null, endLine: null }]);
        calls.push(['find_usages', { symbol: rounds === 0 ? 'getSession' : 'addToCart' }]);
        return toolCall(calls);
      }
      if (text.includes('ROLE: RESPONDER') && toolNames.includes('read_file') && rounds === 0 && json.tool_choice !== 'none') {
        return toolCall([['read_file', { path: 'src/lib/auth.ts', startLine: null, endLine: null }]]);
      }

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
