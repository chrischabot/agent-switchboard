import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { CreateTaskResultV2Schema, GetTaskResultV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
import { Store } from '../src/store.mjs';
import { Broker } from '../src/broker.mjs';
import { serveHub } from '../src/http.mjs';

const revision = '2026-07-28';
const taskCapabilities = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
const formCapabilities = { elicitation: { form: {} } };
const form = { mode: 'form', message: 'Choose a test colour', requestedSchema: {
  type: 'object', properties: { colour: { type: 'string', enum: ['red', 'blue'] } },
  required: ['colour'], additionalProperties: false,
} };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, { holdWrites = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-http-test-'));
  const tokens = Object.fromEntries(['alice', 'bob', 'restricted'].map(id => [id, randomBytes(32).toString('hex')]));
  const clients = {};
  for (const [id, token] of Object.entries(tokens)) {
    const tokenFile = path.join(directory, `${id}.token`);
    await writeFile(tokenFile, token, { mode: 0o600 });
    clients[id] = { tokenFile, providers: id === 'restricted' ? [] : ['fixture'] };
  }
  const release = deferred();
  const calls = [];
  // This is the downstream service boundary. It does not implement hub tasks,
  // idempotency, authorization, subscriptions or elicitation under test.
  const provider = {
    descriptor: { id: 'fixture', kind: 'fixture', support: 'native', availability: 'ready' },
    catalog: ['fixture_read', 'fixture_write'].map(name => ({ name, description: name,
      inputSchema: { type: 'object' }, annotations: { readOnlyHint: name === 'fixture_read' } })),
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'fixture_write' && holdWrites) await release.promise;
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', nonce: args.nonce }) }],
        structuredContent: { status: 'accepted', nonce: args.nonce } };
    },
    async close() {},
  };
  const store = new Store(path.join(directory, 'state.sqlite'));
  const broker = new Broker(store, new Map([['fixture', provider]]), { clients });
  const service = await serveHub(broker, { port: 0 });
  const controllers = new Set();
  t.after(async () => {
    release.resolve();
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...broker.running.values()]);
    await service.close();
    await broker.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  let counter = 0;
  async function post(method, params = {}, options = {}) {
    const id = ++counter;
    const legacy = options.legacy === true;
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tokens[options.caller ?? 'alice']}` });
    const bodyParams = legacy ? params : { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': revision,
      'io.modelcontextprotocol/clientInfo': { name: 'hub-wire-test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': options.capabilities ?? {},
      ...params._meta,
    } };
    if (!legacy) {
      headers.set('mcp-protocol-version', revision);
      headers.set('mcp-method', method);
      const mirrored = params.name ?? params.uri ?? params.taskId;
      if (mirrored !== undefined) headers.set('mcp-name', mirrored);
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value === null) headers.delete(name); else headers.set(name, value);
    }
    const response = await fetch(`http://127.0.0.1:${service.port}/mcp`, {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: bodyParams }),
      signal: options.signal ?? AbortSignal.timeout(5000),
    });
    return { response, id };
  }
  async function rpc(method, params = {}, options = {}) {
    const { response, id } = await post(method, params, options);
    const text = await response.text();
    let body;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      body = text.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => JSON.parse(line.slice(5).trim())).find(message => message.id === id);
    } else body = text ? JSON.parse(text) : undefined;
    return { status: response.status, headers: response.headers, body };
  }
  async function call(name, args = {}, options = {}) {
    return rpc('tools/call', { name, arguments: args, ...options.retry }, options);
  }
  async function subscribe(caller = 'alice') {
    const controller = new AbortController();
    controllers.add(controller);
    const { response, id } = await post('subscriptions/listen', {
      notifications: { resourceSubscriptions: ['switchboard://events'] },
    }, { caller, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function next() {
      for (;;) {
        const split = buffer.indexOf('\n\n');
        if (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim()).join('\n');
          if (data) return JSON.parse(data);
          continue;
        }
        const read = await reader.read();
        if (read.done) throw new Error('Subscription ended before the expected notification');
        buffer += decoder.decode(read.value, { stream: true }).replace(/\r\n/g, '\n');
      }
    }
    return { id, next, close: () => controller.abort() };
  }
  async function wrongHost() {
    return new Promise((resolve, reject) => {
      const req = nodeRequest({ hostname: '127.0.0.1', port: service.port, path: '/mcp', method: 'POST',
        headers: { host: 'attacker.invalid', authorization: `Bearer ${tokens.alice}` } }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
      req.once('error', reject);
      req.end('{}');
    });
  }
  return { store, broker, calls, release: release.resolve, rpc, call, subscribe, wrongHost };
}

const toolResult = response => {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body?.error, undefined, JSON.stringify(response.body));
  assert.notEqual(response.body.result?.isError, true, JSON.stringify(response.body));
  return response.body.result;
};
const toolError = (response, code) => {
  assert.equal(response.body?.result?.isError, true, JSON.stringify(response.body));
  assert.equal(response.body.result.structuredContent.code, code);
};
const write = (f, requestId, nonce = 'fixture-nonce', options = {}) => f.call('provider_call', {
  provider: 'fixture', name: 'fixture_write', arguments: { nonce }, requestId,
}, options);

test('modern discovery advertises its version and requires consistent standard headers', async t => {
  const f = await fixture(t);
  const discover = toolResult(await f.rpc('server/discover'));
  assert.ok(discover.supportedVersions.includes(revision));
  assert.deepEqual(discover.capabilities.extensions['io.modelcontextprotocol/tasks'], {});
  assert.equal(discover.capabilities.resources.subscribe, true);
  for (const headers of [
    { 'mcp-protocol-version': null }, { 'mcp-method': null },
    { 'mcp-method': 'resources/list' }, { 'mcp-name': null }, { 'mcp-name': 'wrong_tool' },
  ]) {
    const response = await f.call('agents_list', {}, { headers });
    assert.ok(response.status >= 400 || response.body?.error, JSON.stringify(response.body));
  }
  assert.equal(f.calls.length, 0);
});

test('legacy initialize and tools remain usable without modern Task results', async t => {
  const f = await fixture(t);
  const initialized = toolResult(await f.rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-fixture', version: '1' },
  }, { legacy: true }));
  assert.equal(initialized.protocolVersion, '2025-11-25');
  const tools = toolResult(await f.rpc('tools/list', {}, { legacy: true }));
  assert.ok(tools.tools.some(tool => tool.name === 'provider_call'));
  const result = toolResult(await write(f, 'legacy-write-1', 'legacy', { legacy: true }));
  assert.notEqual(result.resultType, 'task');
  assert.equal(result.structuredContent.kind, 'operation');
  assert.equal(f.calls.length, 1);
});

test('Tasks opt-in returns a durable task and tasks/get reports the actual provider result', async t => {
  const f = await fixture(t, { holdWrites: true });
  const created = toolResult(await write(f, 'task-write-1', 'task-nonce', { capabilities: taskCapabilities }));
  assert.equal(created.resultType, 'task');
  assert.equal(CreateTaskResultV2Schema.safeParse(created).success, true);
  const working = toolResult(await f.rpc('tasks/get', { taskId: created.taskId }, { capabilities: taskCapabilities }));
  assert.equal(working.status, 'working');
  assert.equal(GetTaskResultV2Schema.safeParse(working).success, true);
  f.release();
  await Promise.all([...f.broker.running.values()]);
  const finished = toolResult(await f.rpc('tasks/get', { taskId: created.taskId }, { capabilities: taskCapabilities }));
  assert.equal(finished.status, 'completed');
  assert.equal(GetTaskResultV2Schema.safeParse(finished).success, true);
  assert.equal(finished.result.structuredContent.completionScope, 'provider_tool_call');
  assert.equal(finished.result.structuredContent.operation.result.structuredContent.nonce, 'task-nonce');
});

test('Tasks-unaware callers receive ordinary receipts and duplicate mutations do not dispatch twice', async t => {
  const f = await fixture(t, { holdWrites: true });
  const first = toolResult(await write(f, 'dedup-write-1'));
  assert.equal(first.resultType, 'complete');
  assert.equal(first.structuredContent.kind, 'operation');
  const repeated = toolResult(await write(f, 'dedup-write-1'));
  assert.equal(repeated.structuredContent.operation.id, first.structuredContent.operation.id);
  toolError(await write(f, 'dedup-write-1', 'changed'), 'conflict');
  assert.equal(f.calls.length, 1);
});

test('tasks/get remains usable for an ordinary operation receipt, and active cancellation cannot claim to stop native work', async t => {
  const f = await fixture(t, { holdWrites: true });
  const receipt = toolResult(await write(f, 'poll-receipt-1', 'poll-nonce'));
  const taskId = receipt.structuredContent.operation.id;
  const working = toolResult(await f.rpc('tasks/get', { taskId }, { capabilities: taskCapabilities }));
  assert.equal(working.status, 'working');
  assert.equal(GetTaskResultV2Schema.safeParse(working).success, true);
  const cancellation = await f.rpc('tasks/cancel', { taskId }, { capabilities: taskCapabilities });
  assert.equal(toolResult(cancellation).resultType, 'complete');
  const afterCancellation = toolResult(await f.rpc('tasks/get', { taskId }, { capabilities: taskCapabilities }));
  assert.equal(afterCancellation.status, 'working');
  assert.equal(f.store.get('alice', taskId).status, 'dispatching');
  assert.equal(f.calls.length, 1);
  f.release();
  await Promise.all([...f.broker.running.values()]);
  const completed = toolResult(await f.rpc('tasks/get', { taskId }, { capabilities: taskCapabilities }));
  assert.equal(completed.status, 'completed');
  assert.equal(GetTaskResultV2Schema.safeParse(completed).success, true);
  assert.equal(completed.result.structuredContent.operation.result.structuredContent.nonce, 'poll-nonce');
});

test('invalid Tasks extension values cannot enable task handles', async t => {
  const f = await fixture(t);
  for (const [index, capability] of [null, true, { enabled: true }].entries()) {
    const response = await write(f, `invalid-task-capability-${index}`, 'invalid-capability', {
      capabilities: { extensions: { 'io.modelcontextprotocol/tasks': capability } },
    });
    if (response.body?.error || response.status >= 400) continue;
    assert.notEqual(response.body.result?.resultType, 'task', JSON.stringify(response.body));
  }
});

test('bearer authentication, origin protection and provider grants reject before dispatch', async t => {
  const f = await fixture(t);
  for (const headers of [{ authorization: null }, { authorization: 'Bearer invalid' },
    { origin: 'https://attacker.invalid' }]) {
    const response = await write(f, 'unauthorized-write', 'guard', { headers });
    assert.ok(response.status === 401 || response.status === 403, JSON.stringify(response.body));
  }
  assert.equal(await f.wrongHost(), 403);
  toolError(await write(f, 'restricted-write', 'guard', { caller: 'restricted' }), 'forbidden');
  assert.equal(f.calls.length, 0);
});

test('invalid public tool arguments are rejected before any downstream invocation', async t => {
  const f = await fixture(t);
  for (const args of [
    { provider: 'fixture', name: 'fixture_write', arguments: [], requestId: 'invalid-args-1' },
    { provider: 'fixture', name: 'fixture_write', arguments: {}, requestId: 'short' },
    { provider: 'fixture', name: 'fixture_write', arguments: {}, requestId: 'invalid-args-2', caller: 'bob' },
  ]) toolError(await f.call('provider_call', args), 'invalid_arguments');
  toolError(await f.call('not_a_tool'), 'invalid_arguments');
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.list('alice').length, 0);
});

test('operation tools, Task lookup and resources cannot cross caller ownership', async t => {
  const f = await fixture(t);
  const result = toolResult(await write(f, 'owned-operation-1'));
  const id = result.structuredContent.operation.id;
  toolError(await f.call('operations_get', { operationId: id }, { caller: 'bob' }), 'not_found');
  toolError(await f.call('operations_cancel', { operationId: id }, { caller: 'bob' }), 'not_found');
  const task = await f.rpc('tasks/get', { taskId: id }, { caller: 'bob', capabilities: taskCapabilities });
  assert.ok(task.body?.error || task.status >= 400, JSON.stringify(task.body));
  const resource = await f.rpc('resources/read', { uri: `switchboard://operations/${id}` }, { caller: 'bob' });
  assert.ok(resource.body?.error || resource.status >= 400, JSON.stringify(resource.body));
  assert.deepEqual(toolResult(await f.call('operations_list', {}, { caller: 'bob' })).structuredContent.operations, []);
  assert.deepEqual(toolResult(await f.call('events_read', {}, { caller: 'bob' })).structuredContent.events, []);
  const other = toolResult(await write(f, 'owned-operation-1', 'bob-nonce', { caller: 'bob' }));
  assert.notEqual(other.structuredContent.operation.id, id);
});

test('subscription acknowledgment is followed by a real scoped journal notification and replay',
  { timeout: 10000 }, async t => {
    const f = await fixture(t, { holdWrites: true });
    const subscription = await f.subscribe();
    const ack = await subscription.next();
    assert.equal(ack.method, 'notifications/subscriptions/acknowledged');
    assert.deepEqual(ack.params.notifications.resourceSubscriptions, ['switchboard://events']);
    assert.equal(ack.params._meta['io.modelcontextprotocol/subscriptionId'], subscription.id);
    const pending = subscription.next();
    await write(f, 'bob-event-write', 'bob-secret', { caller: 'bob' });
    let timeout;
    const first = await Promise.race([pending, new Promise(resolve => { timeout = setTimeout(() => resolve('quiet'), 75); })]);
    clearTimeout(timeout);
    assert.equal(first, 'quiet', 'Another caller must not trigger this journal subscription');
    const written = toolResult(await write(f, 'alice-event-write', 'alice-nonce'));
    const notification = await pending;
    assert.equal(notification.method, 'notifications/resources/updated');
    assert.equal(notification.params.uri, 'switchboard://events');
    assert.equal(notification.params._meta['io.modelcontextprotocol/subscriptionId'], subscription.id);
    const replay = toolResult(await f.call('events_read')).structuredContent;
    assert.ok(replay.events.length > 0);
    assert.ok(replay.events.every(event => event.principal === 'alice'));
    assert.ok(replay.events.every(event => event.object_id === written.structuredContent.operation.id));
    const resource = toolResult(await f.rpc('resources/read', { uri: 'switchboard://events' }));
    assert.deepEqual(JSON.parse(resource.contents[0].text), replay);
    subscription.close();
  });

for (const action of ['accept', 'decline', 'cancel']) {
  test(`form elicitation ${action} is correlated and durably recorded through HTTP`, async t => {
    const f = await fixture(t);
    const question = f.store.ask('alice', null, form);
    const pending = toolResult(await f.call('questions_present', { questionId: question }, { capabilities: formCapabilities }));
    assert.equal(pending.resultType, 'input_required');
    assert.equal(pending.inputRequests[question].method, 'elicitation/create');
    assert.deepEqual(pending.inputRequests[question].params, form);
    const answer = action === 'accept' ? { action, content: { colour: 'blue' } } : { action };
    const answered = toolResult(await f.call('questions_present', { questionId: question }, {
      capabilities: formCapabilities, retry: { inputResponses: { [question]: answer } },
    }));
    assert.equal(answered.resultType, 'complete');
    assert.deepEqual(answered.structuredContent.response, answer);
    assert.deepEqual(f.store.question('alice', question).response, answer);
    assert.equal(f.store.events('alice').events.filter(event => event.topic === 'question.answered').length, 1);
  });
}

test('invalid or foreign form responses cannot answer a pending human question', async t => {
  const f = await fixture(t);
  const question = f.store.ask('alice', null, form);
  toolError(await f.call('questions_present', { questionId: question }, {
    capabilities: formCapabilities, retry: { inputResponses: { [question]: { action: 'accept', content: { colour: 'green' } } } },
  }), 'invalid_answer');
  toolError(await f.call('questions_present', { questionId: question }, { caller: 'bob', capabilities: formCapabilities }), 'not_found');
  const unrelated = toolResult(await f.call('questions_present', { questionId: question }, {
    capabilities: formCapabilities, retry: { inputResponses: { 'another-question': { action: 'accept', content: { colour: 'red' } } } },
  }));
  assert.equal(unrelated.resultType, 'input_required');
  assert.equal(f.store.question('alice', question).response, null);
  assert.equal(f.store.events('alice').events.filter(event => event.topic === 'question.answered').length, 0);
});

test('a caller lacking form capability is never sent an unsupported form request', async t => {
  const f = await fixture(t);
  const question = f.store.ask('alice', null, form);
  const response = await f.call('questions_present', { questionId: question });
  assert.ok(response.body?.error || response.status >= 400, JSON.stringify(response.body));
  assert.equal(f.store.question('alice', question).response, null);
});
