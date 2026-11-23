import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { CreateMessageRequestV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
import { Store } from '../src/store.mjs';
import { Broker } from '../src/broker.mjs';
import { McpProvider } from '../src/providers.mjs';
import { serveHub } from '../src/http.mjs';

const capabilities = { extensions: { 'io.modelcontextprotocol/tasks': {} }, elicitation: { form: {}, url: {} } };
const form = { method: 'elicitation/create', params: { mode: 'form', message: 'Choose a fixture colour',
  requestedSchema: { type: 'object', properties: { colour: { type: 'string', enum: ['red', 'blue'] } }, required: ['colour'], additionalProperties: false },
} };
const urlQuestion = { method: 'elicitation/create', params: { mode: 'url', message: 'Complete fixture authentication',
  url: 'https://fixture.invalid/authorize?continuation=opaque' } };
const opaque = 'opaque-state +/== with whitespace\nkept verbatim';

async function fixture(t, { questions = { upstream_question: form }, start = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-relay-test-'));
  const filename = path.join(directory, 'store.sqlite');
  const calls = [];
  const downstreamHandler = createMcpHandler(() => {
    const server = new Server({ name: 'elicitation-fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'fixture_action',
      inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false },
      annotations: { readOnlyHint: false },
    }] }));
    server.setRequestHandler('tools/call', async (request, ctx) => {
      const observed = { name: request.params.name, arguments: request.params.arguments,
        inputResponses: ctx.mcpReq.inputResponses, requestState: ctx.mcpReq.requestState() };
      calls.push(observed);
      if (!observed.inputResponses || Object.keys(observed.inputResponses).length === 0)
        return { resultType: 'input_required', inputRequests: questions, requestState: opaque };
      return { content: [{ type: 'text', text: 'Fixture continuation complete' }],
        structuredContent: { completed: true, nonce: request.params.arguments.nonce, inputResponses: observed.inputResponses } };
    });
    return server;
  });
  const downstream = createServer(toNodeHandler(downstreamHandler));
  await new Promise(resolve => downstream.listen(0, '127.0.0.1', resolve));
  const downstreamUrl = `http://127.0.0.1:${downstream.address().port}/mcp`;
  const tokens = { alice: 'alice-fixture-token-'.repeat(3), bob: 'bob-fixture-token-'.repeat(3) };
  const clients = {};
  for (const [id, token] of Object.entries(tokens)) {
    const tokenFile = path.join(directory, `${id}.token`);
    await writeFile(tokenFile, token, { mode: 0o600 });
    clients[id] = { tokenFile, providers: ['fixture'] };
  }
  let store, broker, service, provider;
  async function open() {
    store = new Store(filename);
    provider = new McpProvider('fixture', { url: downstreamUrl, supportsInputRequired: true });
    await provider.connect();
    broker = new Broker(store, new Map([['fixture', provider]]), { clients });
    service = await serveHub(broker, { port: 0 });
    broker.recover();
  }
  if (start) await open();
  t.after(async () => {
    if (broker) {
      await Promise.allSettled([...broker.running.values()]);
      await service.close();
      await broker.close();
      store.close();
    }
    await downstreamHandler.close();
    downstream.closeAllConnections();
    await new Promise(resolve => downstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  let counter = 0;
  async function rpc(method, params, caller = 'alice', clientCapabilities = capabilities) {
    const id = ++counter;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tokens[caller]}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': method };
    const mirrored = params.name ?? params.taskId ?? params.uri;
    if (mirrored !== undefined) headers['mcp-name'] = mirrored;
    const response = await fetch(`http://127.0.0.1:${service.port}/mcp`, { method: 'POST', headers,
      signal: AbortSignal.timeout(5000), body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': clientCapabilities },
      } }),
    });
    const text = await response.text();
    const body = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(item => item.id === id)
      : JSON.parse(text);
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  const settled = async () => { while (broker.running.size) await Promise.all([...broker.running.values()]); };
  return { directory, filename, downstreamUrl, calls, open, rpc, settled,
    get store() { return store; }, get broker() { return broker; },
    async reconnectFrontend() { await service.close(); service = await serveHub(broker, { port: 0 }); },
    async startTask(requestId = 'relay-request-1', nonce = 'original-nonce') {
      const reply = await rpc('tools/call', { name: 'provider_call', arguments: {
        provider: 'fixture', name: 'fixture_action', arguments: { nonce }, requestId,
      } });
      const created = success(reply);
      assert.equal(created.resultType, 'task');
      await settled();
      return success(await rpc('tasks/get', { taskId: created.taskId }));
    },
  };
}

function success(reply) {
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.notEqual(reply.result?.isError, true, JSON.stringify(reply));
  return reply.result;
}
function pending(task) {
  assert.equal(task.status, 'input_required', JSON.stringify(task));
  const ids = Object.keys(task.inputRequests);
  assert.ok(ids.length > 0);
  return ids;
}

for (const action of ['accept', 'decline', 'cancel']) {
  test(`actual downstream form ${action} resumes the original tool, arguments and opaque state`, async t => {
    const f = await fixture(t);
    const task = await f.startTask();
    const [questionId] = pending(task);
    assert.equal(f.calls.length, 1);
    const presentation = success(await f.rpc('tools/call', { name: 'questions_present', arguments: { questionId } }));
    assert.equal(presentation.resultType, 'input_required');
    assert.deepEqual(presentation.inputRequests[questionId].params.requestedSchema, form.params.requestedSchema);
    const answer = action === 'accept' ? { action, content: { colour: 'blue' } } : { action };
    success(await f.rpc('tools/call', { name: 'questions_present', arguments: { questionId }, inputResponses: { [questionId]: answer } }));
    await f.settled();
    const done = success(await f.rpc('tasks/get', { taskId: task.taskId }));
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].name, 'fixture_action');
    assert.deepEqual(f.calls[1].arguments, { nonce: 'original-nonce' });
    assert.equal(f.calls[1].requestState, opaque);
    assert.deepEqual(f.calls[1].inputResponses, { upstream_question: answer });
    assert.deepEqual(f.store.question('alice', questionId).response, answer);
  });
}

test('actual downstream URL elicitation survives a frontend reconnect and tasks/update resumes it once', async t => {
  const f = await fixture(t, { questions: { upstream_url: urlQuestion } });
  const task = await f.startTask('url-relay-request');
  const [questionId] = pending(task);
  assert.equal(task.inputRequests[questionId].params.url, urlQuestion.params.url);
  await f.reconnectFrontend();
  const restored = success(await f.rpc('tasks/get', { taskId: task.taskId }));
  assert.deepEqual(restored.inputRequests, task.inputRequests);
  success(await f.rpc('tasks/update', { taskId: task.taskId, inputResponses: { [questionId]: { action: 'accept' } } }));
  await f.settled();
  assert.equal(success(await f.rpc('tasks/get', { taskId: task.taskId })).status, 'completed');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].inputResponses, { upstream_url: { action: 'accept' } });
  assert.equal(f.calls[1].requestState, opaque);
});

test('duplicate human responses never replay a completed continuation, and conflicting responses are rejected', async t => {
  const f = await fixture(t);
  const task = await f.startTask('response-retry-1');
  const [questionId] = pending(task);
  const request = { name: 'questions_present', arguments: { questionId },
    inputResponses: { [questionId]: { action: 'accept', content: { colour: 'blue' } } } };
  success(await f.rpc('tools/call', request));
  await f.settled();
  success(await f.rpc('tools/call', request));
  const conflicting = await f.rpc('tools/call', { ...request,
    inputResponses: { [questionId]: { action: 'accept', content: { colour: 'red' } } } });
  assert.equal(conflicting.result?.isError, true, JSON.stringify(conflicting));
  assert.equal(conflicting.result.structuredContent.code, 'conflict');
  assert.equal(f.calls.length, 2);
});

test('partial multiquestion answers expose only unanswered inputs and resume once when all are answered', async t => {
  const f = await fixture(t, { questions: { upstream_first: form, upstream_second: form } });
  const task = await f.startTask('multiple-relay-1');
  const [first, second] = pending(task);
  assert.equal(Object.keys(task.inputRequests).length, 2);
  success(await f.rpc('tasks/update', { taskId: task.taskId,
    inputResponses: { [first]: { action: 'accept', content: { colour: 'red' } } } }));
  assert.equal(f.calls.length, 1);
  const remaining = success(await f.rpc('tasks/get', { taskId: task.taskId }));
  assert.equal(remaining.status, 'input_required');
  assert.deepEqual(Object.keys(remaining.inputRequests), [second]);
  success(await f.rpc('tasks/update', { taskId: task.taskId,
    inputResponses: { [second]: { action: 'decline' } } }));
  await f.settled();
  assert.equal(success(await f.rpc('tasks/get', { taskId: task.taskId })).status, 'completed');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].inputResponses, {
    upstream_first: { action: 'accept', content: { colour: 'red' } }, upstream_second: { action: 'decline' },
  });
});

test('a batch with an invalid second answer does not persist the first answer', async t => {
  const f = await fixture(t, { questions: { upstream_first: form, upstream_second: form } });
  const task = await f.startTask('atomic-relay-1');
  const [first, second] = pending(task);
  assert.throws(() => f.broker.updateTask('alice', task.taskId, {
    [first]: { action: 'accept', content: { colour: 'red' } },
    [second]: { action: 'accept', content: { colour: 'invalid-colour' } },
  }), { code: 'invalid_answer' });
  assert.equal(f.store.question('alice', first).response, null);
  assert.equal(f.store.question('alice', second).response, null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get('alice', task.taskId).status, 'waiting_input');
});

test('cross-task and cross-caller input responses cannot release another native request', async t => {
  const f = await fixture(t);
  const first = await f.startTask('scoped-relay-1', 'nonce-one');
  const second = await f.startTask('scoped-relay-2', 'nonce-two');
  const [firstQuestion] = pending(first), [secondQuestion] = pending(second);
  const foreign = await f.rpc('tasks/update', { taskId: first.taskId,
    inputResponses: { [secondQuestion]: { action: 'cancel' } } });
  assert.ok(foreign.error);
  const otherCaller = await f.rpc('tasks/update', { taskId: first.taskId,
    inputResponses: { [firstQuestion]: { action: 'cancel' } } }, 'bob');
  assert.ok(otherCaller.error);
  assert.equal(f.store.question('alice', firstQuestion).response, null);
  assert.equal(f.store.question('alice', secondQuestion).response, null);
  success(await f.rpc('tasks/update', { taskId: first.taskId,
    inputResponses: { [firstQuestion]: { action: 'cancel' } } }));
  await f.settled();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].arguments.nonce, 'nonce-one');
  assert.equal(f.store.get('alice', second.taskId).status, 'waiting_input');
});

test('unsupported downstream sampling fails closed without a fabricated answer or human question', async t => {
  const sampling = { method: 'sampling/createMessage',
    params: { messages: [{ role: 'user', content: { type: 'text', text: 'Fixture sampling request' } }], maxTokens: 10 },
  };
  assert.equal(CreateMessageRequestV2Schema.safeParse(sampling).success, true);
  const f = await fixture(t, { questions: { upstream_sampling: sampling } });
  const task = await f.startTask('sampling-relay-1');
  assert.equal(task.status, 'failed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.events('alice').events.filter(event => event.topic === 'question.created').length, 0);
});

test('pending elicitation survives a killed broker process and retry does not repeat the original native call',
  { timeout: 15000 }, async t => {
    const f = await fixture(t, { start: false });
    const script = `
      import { Store } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
      import { Broker } from ${JSON.stringify(new URL('../src/broker.mjs', import.meta.url).href)};
      import { McpProvider } from ${JSON.stringify(new URL('../src/providers.mjs', import.meta.url).href)};
      const store = new Store(${JSON.stringify(f.filename)});
      const provider = new McpProvider('fixture',{url:${JSON.stringify(f.downstreamUrl)},supportsInputRequired:true});
      await provider.connect();
      const broker = new Broker(store,new Map([['fixture',provider]]),{clients:{alice:{providers:['fixture']}}});
      const receipt = await broker.invoke('alice','fixture','fixture_action',{nonce:'original-nonce'},'crashed-relay');
      await Promise.all([...broker.running.values()]);
      const operation = store.get('alice', receipt.operation.id);
      if (operation.status !== 'waiting_input') throw new Error(JSON.stringify(operation));
      process.stdout.write(JSON.stringify({taskId:operation.id}),()=>process.kill(process.pid,'SIGKILL'));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const exited = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(exited.signal, 'SIGKILL', stderr);
    const { taskId } = JSON.parse(stdout);
    assert.equal(f.calls.length, 1);
    await f.open();
    const restored = success(await f.rpc('tasks/get', { taskId }));
    const [questionId] = pending(restored);
    const retried = await f.startTask('crashed-relay');
    assert.equal(retried.taskId, taskId);
    assert.equal(f.calls.length, 1);
    success(await f.rpc('tasks/update', { taskId,
      inputResponses: { [questionId]: { action: 'accept', content: { colour: 'blue' } } } }));
    await f.settled();
    assert.equal(success(await f.rpc('tasks/get', { taskId })).status, 'completed');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].requestState, opaque);
    assert.deepEqual(f.calls[1].arguments, { nonce: 'original-nonce' });
  });
