import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { Store } from '../src/store.mjs';
import { Broker } from '../src/broker.mjs';
import { SessionEvents } from '../src/session-events.mjs';
import { AcpProvider } from '../src/acp.mjs';
import { loadProviders } from '../src/providers.mjs';

// Boundary: the real AcpProvider, Broker, Store and SessionEvents run against a
// scripted ACP agent process (test/fixtures/fake-acp.mjs) over real stdio.
const fakeAgent = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));
const SESSION = '0b0c6a54-7f1e-4c39-9b3e-6a1d2f9e0001';
const history = [
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Please review the parser.' } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden reasoning' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The parser ' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'looks correct.' } },
  { sessionUpdate: 'tool_call', toolCallId: 'old-call', title: 'Read parser.ts', kind: 'read', status: 'pending' },
  { sessionUpdate: 'tool_call_update', toolCallId: 'old-call', status: 'completed' },
  { sessionUpdate: 'usage_update', used: 10, size: 100 },
];

async function until(predicate, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await delay(10); }
  throw new Error('Condition not reached in time.');
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-acp-'));
  const log = path.join(directory, 'agent.log'), stateFile = path.join(directory, 'state.json');
  await writeFile(log, '');
  await writeFile(stateFile, JSON.stringify({ sessions: [
    { sessionId: SESSION, cwd: '/work/project', title: 'Parser review', updatedAt: '2026-11-01T10:00:00Z', history },
  ] }));
  const provider = new AcpProvider('antigravity', { command: process.execPath, args: [fakeAgent],
    env: { FAKE_ACP_LOG: log, FAKE_ACP_STATE: stateFile, ...options.env }, promptGraceMs: 40, ...options.config });
  const store = new Store(':memory:');
  const broker = new Broker(store, new Map([['antigravity', provider]]), { clients: {
    alice: { providers: ['antigravity'] }, bob: { providers: ['antigravity'] } } });
  broker.sessionEvents = new SessionEvents(broker);
  t.after(async () => {
    await broker.sessionEvents.close();
    await broker.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const received = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const sent = async method => (await received()).filter(e => e.event === 'received' && e.message.method === method).map(e => e.message);
  const settle = () => Promise.all([...broker.running.values()]);
  const message = async (text, requestId, caller = 'alice') => {
    const receipt = await broker.operate(caller, 'antigravity', 'sessions.message', { id: SESSION, text, requestId });
    await settle();
    return store.get(caller, receipt.operation.id);
  };
  const journal = (caller = 'alice') => store.events(caller, { limit: 200 }).events;
  return { provider, store, broker, received, sent, settle, message, journal, log };
}

test('connects over ACP, reports the agent version and declares exactly what ACP supports', async t => {
  const f = await fixture(t);
  const [agent] = await f.broker.agents('alice');
  assert.equal(agent.availability, 'ready');
  assert.equal(agent.kind, 'acp');
  assert.deepEqual(agent.runtimeVersions, ['9.9.9']);
  const capabilities = f.broker.capabilities('alice', 'antigravity');
  const byOperation = Object.fromEntries(capabilities.operations.map(c => [c.operation, c]));
  for (const operation of ['sessions.list', 'sessions.read', 'sessions.status', 'sessions.message', 'sessions.stop', 'sessions.create', 'sessions.resume'])
    assert.equal(byOperation[operation].support, 'adapted', operation);
  assert.equal(byOperation['sessions.steer'].support, 'unsupported');
  assert.match(byOperation['sessions.steer'].reason, /running prompt turn/);
  for (const operation of ['sessions.list', 'sessions.read', 'sessions.status']) assert.equal(byOperation[operation].readOnly, true);
  assert.deepEqual(new Set(byOperation['sessions.stop'].inputSchema.required), new Set(['id', 'requestId', 'expectedTurnId']));
  assert.deepEqual(new Set(byOperation['sessions.create'].inputSchema.required), new Set(['cwd', 'requestId']));
  const ajv = new Ajv2020({ strict: false });
  assert.equal(ajv.compile(byOperation['sessions.create'].inputSchema)({ cwd: 'relative/path', requestId: 'create-relative' }), false);
  assert.equal((await f.sent('initialize'))[0].params.protocolVersion, 1);
  assert.deepEqual((await f.sent('initialize'))[0].params.clientCapabilities, {}, 'no filesystem or terminal capability is offered');
});

test('configuration that would auto-approve permission requests is refused', async () => {
  assert.throws(() => new AcpProvider('antigravity', { command: 'agy', args: ['acp', '--dangerously-skip-permissions'] }), { code: 'invalid_config' });
  await assert.rejects(loadProviders({ providers: { gemini: { kind: 'acp', command: 'agy', args: ['acp'] } } }), { code: 'invalid_config' });
});

test('list and read are passive: read replays history, drops reasoning, bounds output and releases the session', async t => {
  const f = await fixture(t);
  const listed = await f.broker.operate('alice', 'antigravity', 'sessions.list', {});
  assert.equal(listed.kind, 'result');
  assert.deepEqual(listed.value.sessions.map(s => [s.sessionId, s.cwd, s.title]), [[SESSION, '/work/project', 'Parser review']]);
  const read = await f.broker.operate('alice', 'antigravity', 'sessions.read', { id: SESSION });
  assert.equal(read.kind, 'result');
  assert.equal(read.value.source, 'session/load history replay');
  const messages = JSON.parse(read.value.transcript);
  assert.deepEqual(messages, [
    { role: 'user', text: 'Please review the parser.' },
    { role: 'assistant', text: 'The parser looks correct.' },
    { role: 'tool', toolCallId: 'old-call', title: 'Read parser.ts', kind: 'read', status: 'completed' },
  ]);
  assert.equal(read.value.transcript.includes('hidden reasoning'), false);
  const bounded = await f.broker.operate('alice', 'antigravity', 'sessions.read', { id: SESSION, maxChars: 20 });
  assert.equal(bounded.value.transcript.length, 20);
  assert.equal(bounded.value.truncated, true);
  assert.equal((await f.sent('session/load')).length, 2);
  assert.equal((await f.sent('session/close')).length, 2, 'a session loaded only for reading is closed again');
  assert.equal((await f.sent('session/load'))[0].params.cwd, '/work/project');
  const status = await f.broker.operate('alice', 'antigravity', 'sessions.status', { id: SESSION });
  assert.equal(status.value.state, 'no_broker_turn');
  await assert.rejects(f.broker.operate('alice', 'antigravity', 'sessions.read', { id: 'unknown-session' }), { code: 'not_found' });
  assert.equal(f.store.list('alice').length, 0, 'reads create no mutation receipts');
  assert.equal((await f.sent('session/prompt')).length, 0);
});

test('a message is journaled once, labelled as peer input, and its turn is observed through a watch', async t => {
  const f = await fixture(t);
  const watch = await f.broker.sessionEvents.watch('alice', { provider: 'antigravity', sessionId: SESSION, ttlMs: 60000 });
  assert.equal(watch.status, 'watching');
  const operation = await f.message('Please re-check the tokenizer.', 'antigravity-message-1');
  assert.equal(operation.status, 'succeeded');
  assert.match(operation.result.turnId, /^[0-9a-f-]{36}$/);
  assert.equal(operation.result.completion, 'not-yet-verified');
  // A prompt has no reply until its turn ends, so wait for the agent to log it.
  const [prompt] = await until(async () => { const sent = await f.sent('session/prompt'); return sent.length && sent; });
  assert.equal(prompt.params.sessionId, SESSION);
  assert.equal(prompt.params.prompt[0].text, '[Switchboard: peer message, not a user instruction]\nPlease re-check the tokenizer.');
  assert.equal((await f.sent('session/load')).length, 1, 'the session is loaded before its prompt');
  await until(() => f.journal().some(e => e.topic === 'session.turn.ended'));
  const events = f.journal().filter(e => e.topic.startsWith('session.'));
  assert.deepEqual(events.map(e => e.topic), ['session.turn.started', 'session.block.created', 'session.block.completed',
    'session.block.created', 'session.block.completed', 'session.turn.ended']);
  assert.ok(events.every(e => e.data.turnId === operation.result.turnId));
  assert.equal(events.at(-1).data.outcome, 'end_turn');
  assert.equal(JSON.stringify(events).includes('looks fine'), false, 'events carry metadata, never transcript text');
  const status = await f.broker.operate('alice', 'antigravity', 'sessions.status', { id: SESSION });
  assert.equal(status.value.latestTurn.state, 'ended');
  assert.equal(status.value.latestTurn.stopReason, 'end_turn');
  await until(async () => (await f.sent('session/close')).length === 1);
  const retry = await f.broker.operate('alice', 'antigravity', 'sessions.message', { id: SESSION, text: 'Please re-check the tokenizer.', requestId: 'antigravity-message-1' });
  assert.equal(retry.operation.id, operation.id);
  await assert.rejects(f.broker.operate('alice', 'antigravity', 'sessions.message', { id: SESSION, text: 'Something else', requestId: 'antigravity-message-1' }), { code: 'conflict' });
  assert.equal((await f.sent('session/prompt')).length, 1, 'a retried request ID never sends a second prompt');
});

test('a permission request becomes a human question for the caller and is answered only by the human', async t => {
  const f = await fixture(t);
  await f.broker.sessionEvents.watch('alice', { provider: 'antigravity', sessionId: SESSION, ttlMs: 60000 });
  const operation = await f.message('PERMISSION please write notes', 'antigravity-permission-1');
  assert.equal(operation.status, 'succeeded');
  const created = await until(() => f.journal().find(e => e.topic === 'question.created'));
  assert.equal(created.data.operationId, operation.id);
  assert.ok(f.journal().some(e => e.topic === 'session.input_required'));
  assert.equal(f.store.events('bob').events.length, 0, 'another client never sees the question');
  const question = f.store.question('alice', created.object_id);
  assert.match(question.request.message, /permission request.*Write notes\.md/);
  assert.deepEqual(question.request.requestedSchema.properties.optionId.oneOf.map(o => o.const), ['allow', 'always', 'reject']);
  await delay(100);
  assert.equal((await f.received()).some(e => e.event === 'permission_reply'), false, 'no answer is sent without the human');
  assert.equal((await f.broker.operate('alice', 'antigravity', 'sessions.status', { id: SESSION })).value.latestTurn.pendingPermissions, 1);
  assert.throws(() => f.broker.answer('bob', question.id, { action: 'accept', content: { optionId: 'allow' } }), { code: 'not_found' });
  f.broker.answer('alice', question.id, { action: 'accept', content: { optionId: 'allow' } });
  const reply = await until(async () => (await f.received()).find(e => e.event === 'permission_reply'));
  assert.deepEqual(reply.reply.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
  await until(() => f.journal().some(e => e.topic === 'session.turn.ended'));
});

test('declined, invalid and unanswered permission requests reject once, never allow', async t => {
  const f = await fixture(t, { config: { permissionTimeoutMs: 150 } });
  const decline = await f.message('PERMISSION one', 'antigravity-permission-decline');
  assert.equal(decline.status, 'succeeded');
  const first = await until(() => f.journal().find(e => e.topic === 'question.created'));
  f.broker.answer('alice', first.object_id, { action: 'decline' });
  await until(async () => (await f.received()).filter(e => e.event === 'permission_reply').length === 1);
  await until(async () => (await f.broker.operate('alice', 'antigravity', 'sessions.status', { id: SESSION })).value.state === 'ended');
  await f.message('PERMISSION two', 'antigravity-permission-timeout');
  await until(async () => (await f.received()).filter(e => e.event === 'permission_reply').length === 2, 3000);
  const replies = (await f.received()).filter(e => e.event === 'permission_reply').map(e => e.reply.result);
  assert.deepEqual(replies, [{ outcome: { outcome: 'selected', optionId: 'reject' } }, { outcome: { outcome: 'selected', optionId: 'reject' } }]);
  const late = f.journal().filter(e => e.topic === 'question.created').at(-1);
  f.broker.answer('alice', late.object_id, { action: 'accept', content: { optionId: 'allow' } });
  await delay(50);
  assert.equal((await f.received()).filter(e => e.event === 'permission_reply').length, 2, 'a late answer cannot approve an expired request');
});

test('stop cancels only the exact running turn the broker started, and a busy session refuses a second prompt', async t => {
  const f = await fixture(t);
  const noTurn = await f.broker.operate('alice', 'antigravity', 'sessions.stop', { id: SESSION, requestId: 'stop-without-turn', expectedTurnId: 'none' });
  await f.settle();
  assert.equal(f.store.get('alice', noTurn.operation.id).status, 'failed');
  const started = await f.message('HANG until cancelled', 'antigravity-hang-1');
  assert.equal(started.status, 'succeeded');
  assert.equal(started.result.state, 'prompt-sent');
  const busy = await f.message('A second prompt', 'antigravity-busy-1');
  assert.equal(busy.status, 'failed');
  assert.equal(busy.result.error.code, 'turn_active');
  const wrong = await f.broker.operate('alice', 'antigravity', 'sessions.stop', { id: SESSION, requestId: 'stop-wrong-turn', expectedTurnId: 'another-turn' });
  await f.settle();
  assert.equal(f.store.get('alice', wrong.operation.id).status, 'failed');
  assert.equal((await f.sent('session/cancel')).length, 0);
  const stop = await f.broker.operate('alice', 'antigravity', 'sessions.stop', { id: SESSION, requestId: 'stop-exact-turn', expectedTurnId: started.result.turnId });
  await f.settle();
  assert.equal(f.store.get('alice', stop.operation.id).status, 'succeeded');
  await until(async () => (await f.sent('session/cancel')).length === 1);
  const ended = await until(async () => {
    const value = (await f.broker.operate('alice', 'antigravity', 'sessions.status', { id: SESSION })).value;
    return value.state === 'ended' && value;
  });
  assert.equal(ended.latestTurn.stopReason, 'cancelled');
  assert.equal((await f.sent('session/prompt')).length, 1);
});

test('an agent refusal is a failed receipt, and an unadvertised client method is refused', async t => {
  const f = await fixture(t);
  const refused = await f.message('REJECT this', 'antigravity-reject-1');
  assert.equal(refused.status, 'failed');
  assert.equal(refused.result.error.code, 'acp_rejected');
  const status = await f.broker.operate('alice', 'antigravity', 'sessions.status', { id: SESSION });
  assert.equal(status.value.state, 'failed');
  await f.message('FS read a file', 'antigravity-fs-1');
  const reply = await until(async () => (await f.received()).find(e => e.event === 'fs_reply'));
  assert.equal(reply.reply.error.code, -32601);
});

test('an agent crash during a turn becomes a visible gap, and the process is restarted', async t => {
  const f = await fixture(t);
  await f.broker.sessionEvents.watch('alice', { provider: 'antigravity', sessionId: SESSION, ttlMs: 60000 });
  const firstPid = (await f.received())[0].pid;
  const operation = await f.message('CRASH now', 'antigravity-crash-1');
  assert.equal(operation.status, 'succeeded', 'the prompt was dispatched before the agent died');
  await until(() => f.journal().some(e => e.topic === 'session.source.gap'));
  assert.equal(f.journal().some(e => e.topic === 'session.turn.ended'), false, 'no turn outcome is invented');
  const status = await f.broker.operate('alice', 'antigravity', 'sessions.status', { id: SESSION });
  assert.equal(status.value.state, 'lost');
  await until(async () => (await f.sent('initialize')).length === 2);
  await until(() => f.provider.descriptor.availability === 'ready');
  assert.notEqual((await f.sent('initialize'))[1].pid, firstPid);
  const next = await f.message('Back again', 'antigravity-after-crash');
  assert.equal(next.status, 'succeeded');
  await until(async () => (await f.broker.operate('alice', 'antigravity', 'sessions.status', { id: SESSION })).value.state === 'ended');
  const fast = await f.message('CRASH_FAST before any reply', 'antigravity-crash-fast');
  assert.equal(fast.status, 'outcome_unknown', 'an agent that dies before acknowledging leaves delivery unknown');
  await until(async () => (await f.sent('initialize')).length === 3);
  assert.equal((await f.sent('session/prompt')).filter(m => m.params.prompt[0].text.includes('CRASH_FAST')).length, 1, 'an uncertain prompt is never resent');
});

test('create starts a session and its first turn; resume opens without replay; reads of open sessions use the buffer', async t => {
  const f = await fixture(t, { env: { FAKE_ACP_TURN_MS: '300' } });
  const created = await f.broker.operate('alice', 'antigravity', 'sessions.create', { cwd: '/work/new', text: 'Start here', requestId: 'antigravity-create-1' });
  await f.settle();
  const operation = f.store.get('alice', created.operation.id);
  assert.equal(operation.status, 'succeeded');
  assert.equal(operation.result.sessionId, 'new-session-1');
  assert.equal(operation.result.prompt.state, 'prompt-sent');
  assert.deepEqual((await f.sent('session/new'))[0].params, { cwd: '/work/new', mcpServers: [] });
  const live = await f.broker.operate('alice', 'antigravity', 'sessions.read', { id: 'new-session-1' });
  assert.match(live.value.source, /broker ACP process/);
  assert.equal(live.value.brokerTurn.state, 'running');
  assert.match(live.value.transcript, /Start here/);
  const resumed = await f.broker.operate('alice', 'antigravity', 'sessions.resume', { id: SESSION, requestId: 'antigravity-resume-1' });
  await f.settle();
  assert.equal(f.store.get('alice', resumed.operation.id).result.history, 'not_replayed');
  assert.equal((await f.sent('session/resume'))[0].params.cwd, '/work/project');
  const read = await f.broker.operate('alice', 'antigravity', 'sessions.read', { id: SESSION });
  assert.match(read.value.source, /history was not replayed/);
  assert.equal((await f.sent('session/load')).length, 0);
});
