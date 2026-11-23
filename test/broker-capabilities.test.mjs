import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { Broker, normalizedInputSchema, sessionOperations } from '../src/broker.mjs';
import { DesktopProvider } from '../src/providers.mjs';
import { Store } from '../src/store.mjs';

const ajv = new Ajv2020({ strict: false });

function fixture(t, id) {
  const calls = [], store = new Store(':memory:');
  const provider = new DesktopProvider(id);
  provider.descriptor = { ...provider.descriptor, availability: 'ready' };
  provider.call = async (name, args) => { calls.push({ name, args }); return { sessionId: args.sessionId, state: 'owner-accepted' }; };
  const broker = new Broker(store, new Map([[id, provider]]), { clients: { caller: { providers: [id] } } });
  t.after(async () => { await broker.close(); store.close(); });
  return { broker, calls, store };
}

test('desktop capabilities describe passive reads, the exact input.id field and unsupported operations', async t => {
  const f = fixture(t, 'codex');
  const operations = Object.fromEntries(f.broker.capabilities('caller', 'codex').operations.map(c => [c.operation, c]));
  assert.deepEqual(Object.keys(operations), sessionOperations);
  for (const operation of ['sessions.read', 'sessions.status']) {
    assert.equal(operations[operation].nativeTool, 'codex_read');
    assert.equal(operations[operation].readOnly, true);
    assert.equal(operations[operation].readTool, 'sessions_query');
    const validate = ajv.compile(operations[operation].inputSchema);
    assert.equal(validate({ sessionId: 'fixture-target' }), false);
    assert.equal(validate({ id: 'fixture-target' }), true);
  }
  for (const operation of ['sessions.create', 'sessions.resume']) assert.equal(operations[operation].support, 'unsupported');
  assert.equal(operations['sessions.steer'].nativeTool, 'codex_send');
  const claude = fixture(t, 'claude').broker.capabilities('caller', 'claude').operations;
  assert.deepEqual(claude.filter(c => c.support !== 'unsupported').map(c => c.operation), ['sessions.list', 'sessions.read', 'sessions.status', 'sessions.message']);
  const response = await f.broker.operate('caller', 'codex', 'sessions.status', { id: 'fixture-target' });
  assert.equal(response.kind, 'result');
  assert.deepEqual(f.calls, [{ name: 'codex_read', args: { sessionId: 'fixture-target' } }]);
  assert.equal(f.store.list('caller').length, 0, 'advertised reads produce no mutation receipt or requestId requirement');
});

test('stop requires the exact turn guard and refusal precedes dispatch', async t => {
  const f = fixture(t, 'codex');
  const capability = f.broker.capabilities('caller', 'codex').operations.find(c => c.operation === 'sessions.stop');
  assert.equal(capability.readOnly, false);
  assert.deepEqual(new Set(capability.inputSchema.required), new Set(['id', 'requestId', 'expectedTurnId']));
  const input = { id: '0b0c6a54-7f1e-4c39-9b3e-6a1d2f9e0002', requestId: 'fixture-stop-1' };
  assert.equal(ajv.compile(capability.inputSchema)(input), false);
  await assert.rejects(f.broker.operate('caller', 'codex', 'sessions.stop', input), { code: 'invalid_arguments' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.list('caller').length, 0);
  await f.broker.operate('caller', 'codex', 'sessions.stop', { ...input, expectedTurnId: 'turn_fixture' });
  await Promise.all([...f.broker.running.values()]);
  assert.deepEqual(f.calls, [{ name: 'codex_stop', args: { sessionId: input.id, expectedTurnId: 'turn_fixture' } }]);
});

test('arguments a provider cannot consume are refused rather than silently dropped', async t => {
  const f = fixture(t, 'claude');
  await assert.rejects(f.broker.operate('caller', 'claude', 'sessions.list', { limit: 5 }), { code: 'unsupported_argument' });
  await assert.rejects(f.broker.operate('caller', 'claude', 'sessions.read', { id: 'fixture', cursor: 'must-not-drop' }), { code: 'unsupported_argument' });
  await assert.rejects(f.broker.operate('caller', 'claude', 'sessions.steer', { id: 'fixture', text: 'x', requestId: 'claude-steer-1' }), { code: 'unsupported' });
  assert.equal(f.calls.length, 0);
});

test('generic discovery retains provider-specific limits and schemas enforce mutation prerequisites', () => {
  const generic = ajv.compile(normalizedInputSchema());
  assert.equal(generic({ id: 'fixture', limit: 200 }), true);
  assert.equal(ajv.compile(normalizedInputSchema('codex', 'sessions.list'))({ limit: 101 }), false);
  assert.equal(ajv.compile(normalizedInputSchema('antigravity', 'sessions.list'))({ limit: 200, cursor: 'next' }), true);
  const examples = [
    ['codex', 'sessions.message', { id: 'fixture', requestId: 'fixture-message', text: 'Hello' }, 'text'],
    ['codex', 'sessions.steer', { id: 'fixture', requestId: 'fixture-steer', text: 'Also this' }, 'text'],
    ['antigravity', 'sessions.create', { cwd: '/work/project', requestId: 'fixture-create' }, 'cwd'],
    ['antigravity', 'sessions.stop', { id: 'fixture', requestId: 'fixture-stop', expectedTurnId: 'turn' }, 'expectedTurnId'],
    ['antigravity', 'sessions.resume', { id: 'fixture', requestId: 'fixture-resume' }, 'requestId'],
  ];
  for (const [provider, operation, input, required] of examples) {
    const validate = ajv.compile(normalizedInputSchema(provider, operation));
    assert.equal(validate(input), true, `${provider} ${operation}`);
    assert.equal(generic(input), true, `${provider} ${operation} is accepted by generic discovery`);
    const missing = { ...input }; delete missing[required];
    assert.equal(validate(missing), false, `${provider} ${operation} requires ${required}`);
  }
  assert.throws(() => normalizedInputSchema('codex', 'projects.list'), { code: 'unsupported' });
});
