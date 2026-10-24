import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once, EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

async function fixture(t, capabilities) {
  const calls = [], frames = [], changes = new EventEmitter();
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString()); calls.push(request);
    const params = request.params;
    const result = params.inputResponses ? { resultType: 'complete', content: [{ type: 'text', text: 'human response relayed' }],
      structuredContent: { answer: params.inputResponses.exactQuestion.content?.answer } }
      : { resultType: 'input_required', requestState: 'opaque-upstream-continuation', inputRequests: { exactQuestion: {
        method: 'elicitation/create', params: { mode: 'form', message: 'Choose the fixture colour',
          requestedSchema: { type: 'object', properties: { answer: { type: 'string', enum: ['blue', 'red'] } }, required: ['answer'] } },
      } } };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'switchboard-stdio-'));
  const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'fixture-token-for-private-proxy-testing', { mode: 0o600 });
  const child = spawn(process.execPath, ['bin/client.mjs'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, SWITCHBOARD_URL: `http://127.0.0.1:${server.address().port}/mcp`, SWITCHBOARD_TOKEN_FILE: tokenFile },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const output = createInterface({ input: child.stdout });
  output.on('line', line => { frames.push(JSON.parse(line)); changes.emit('frame'); });
  t.after(async () => {
    child.kill('SIGTERM'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    output.close(); await rm(directory, { recursive: true, force: true });
  });
  const send = value => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const next = async predicate => {
    for (;;) {
      const frame = frames.find(predicate); if (frame) return frame;
      if (child.exitCode !== null) assert.fail(`Proxy exited: ${errors}`);
      await once(changes, 'frame', { signal: AbortSignal.timeout(5000) });
    }
  };
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'legacy-fixture', version: '1' }, capabilities } });
  const initialized = await next(x => x.id === 1); assert.equal(initialized.result.protocolVersion, '2025-06-18');
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'fixture_question', arguments: { target: 'owned-fixture' },
    _meta: { 'openai/executionContext': { thread_id: 'original-codex-context' } } } });
  return { calls, frames, send, next };
}

test('legacy stdio retains declared human form support and relays the exact upstream continuation', async t => {
  const f = await fixture(t, { elicitation: {} });
  const prompt = await f.next(x => x.method === 'elicitation/create');
  assert.equal(prompt.params.message, 'Choose the fixture colour');
  assert.equal(f.calls.length, 1, 'No continuation can run before the client answers');
  f.send({ id: prompt.id, result: { action: 'accept', content: { answer: 'blue' } } });
  const result = await f.next(x => x.id === 2);
  assert.equal(result.result.isError, undefined);
  assert.deepEqual(result.result.structuredContent, { answer: 'blue' });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].params.arguments, { target: 'owned-fixture' });
  assert.equal(f.calls[1].params.requestState, 'opaque-upstream-continuation');
  assert.deepEqual(f.calls[1].params.inputResponses, { exactQuestion: { action: 'accept', content: { answer: 'blue' } } });
  assert.deepEqual(f.calls[1].params._meta['openai/executionContext'], { thread_id: 'original-codex-context' });
  assert.deepEqual(f.calls[0].params._meta['io.modelcontextprotocol/clientCapabilities'], { elicitation: { form: {} } });
});

test('a legacy client that did not declare elicitation is refused without fabricating a human response', async t => {
  const f = await fixture(t, {});
  const result = await f.next(x => x.id === 2);
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /did not declare/);
  assert.equal(f.frames.some(x => x.method === 'elicitation/create'), false);
  assert.equal(f.calls.length, 1);
});

test('declining a legacy form relays the actual human disposition without an invented answer', async t => {
  const f = await fixture(t, { elicitation: { form: {} } });
  const prompt = await f.next(x => x.method === 'elicitation/create');
  f.send({ id: prompt.id, result: { action: 'decline' } });
  await f.next(x => x.id === 2);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].params.inputResponses, { exactQuestion: { action: 'decline' } });
});

test('cancelling the legacy tool call cancels its human form and never resumes upstream', async t => {
  const f = await fixture(t, { elicitation: {} });
  const prompt = await f.next(x => x.method === 'elicitation/create');
  f.send({ method: 'notifications/cancelled', params: { requestId: 2 } });
  const cancelled = await f.next(x => x.method === 'notifications/cancelled');
  assert.equal(cancelled.params.requestId, prompt.id);
  assert.equal(f.calls.length, 1);
});
