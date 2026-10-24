import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Broker } from '../src/broker.mjs';

async function fixture(t, providerId, state) {
  let current = state; const calls = [];
  const names = providerId === 'fabric' ? ['thread_status', 'thread_start', 'thread_steer']
    : providerId === 'codex' ? ['codex_read', 'codex_send'] : ['maestro_inspect', 'maestro_send'];
  const provider = { descriptor: { id: providerId, availability: 'ready' },
    catalog: names.map((name, i) => ({ name, annotations: { readOnlyHint: i === 0 } })),
    call: async (name, args) => { calls.push({ name, args }); return name === names[0] ? current : { accepted: true }; }, close: async () => {} };
  const store = new Store(':memory:'), broker = new Broker(store, new Map([[providerId, provider]]), { clients: { alice: { providers: [providerId] } } });
  t.after(async () => { await broker.close(); store.close(); });
  return { store, broker, calls, setState: value => current = value };
}
const input = { id: 'native-fixture', text: 'A source-observed event occurred.', requestId: 'notification-fixture-1' };

test('a busy Fabric destination receives a guarded steer and recovery cannot resend after it becomes idle', async t => {
  const f = await fixture(t, 'fabric', { turn: { turnId: 'exact-active-turn', status: 'running' } });
  const first = await f.broker.notify('alice', 'fabric', input);
  await Promise.all(f.broker.running.values());
  assert.equal(f.calls[1].name, 'thread_steer');
  assert.equal(f.calls[1].args.expectedTurnId, 'exact-active-turn');
  f.setState({ turn: { state: 'none' } });
  const again = await f.broker.notify('alice', 'fabric', input);
  assert.equal(again.operation.id, first.operation.id);
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.broker.notify('alice', 'fabric', { ...input, text: 'different intent' }), { code: 'conflict' });
  assert.equal(f.calls.length, 2);
});

test('busy Codex uses steer; an idle destination starts a turn without changing native permission context', async t => {
  const f = await fixture(t, 'codex', { latestTurn: { status: 'inProgress' } });
  await f.broker.notify('alice', 'codex', input, { codexThreadId: 'real-sender' });
  await Promise.all(f.broker.running.values());
  assert.equal(f.calls[1].args.mode, 'steer');
  f.setState({ latestTurn: { status: 'completed' } });
  const next = await f.broker.notify('alice', 'codex', { ...input, requestId: 'notification-fixture-2' }, { codexThreadId: 'real-sender' });
  await Promise.all(f.broker.running.values());
  assert.equal(f.calls.at(-1).args.mode, 'start');
  assert.deepEqual(f.store.get('alice', next.operation.id).request.context, { codexThreadId: 'real-sender' });
});

test('a failed or unguarded native status cannot dispatch a follow-up mutation', async t => {
  const f = await fixture(t, 'fabric', { isError: true, structuredContent: { error: { code: 'unavailable' } } });
  await assert.rejects(f.broker.notify('alice', 'fabric', input), { code: 'status_unavailable' });
  f.setState({ turn: { status: 'running' } });
  await assert.rejects(f.broker.notify('alice', 'fabric', input), { code: 'missing_turn_guard' });
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.list('alice').length, 0);
});

test('real Maestro status shape selects steer while unknown or malformed state never defaults to a new turn', async t => {
  const f = await fixture(t, 'maestro', { summary: 'Read completed.', status: 'ok', data: { view: 'summary',
    state: { thread_id: input.id, seq: 1234, status: 'working' } } });
  await f.broker.notify('alice', 'maestro', input);
  await Promise.all(f.broker.running.values());
  assert.equal(f.calls[1].name, 'maestro_send');
  assert.equal(f.calls[1].args.intent, 'steer');
  for (const [index, value] of [{}, { data: { state: { status: 'unknown' } } }, { status: 'rejected', error: { code: 'refused' } }].entries()) {
    f.setState(value);
    await assert.rejects(f.broker.notify('alice', 'maestro', { ...input, requestId: `unknown-state-${index}` }), { code: 'status_unavailable' });
  }
  assert.equal(f.calls.filter(call => call.name === 'maestro_send').length, 1);
});
