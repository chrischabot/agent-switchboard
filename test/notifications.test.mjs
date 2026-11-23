import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Broker } from '../src/broker.mjs';

async function fixture(t, providerId, state, sendResult = { accepted: true }) {
  let current = state; const calls = [];
  const names = providerId === 'codex' ? ['codex_read', 'codex_send'] : ['antigravity_status', 'antigravity_prompt'];
  const provider = { descriptor: { id: providerId, availability: 'ready' },
    catalog: names.map((name, i) => ({ name, annotations: { readOnlyHint: i === 0 } })),
    call: async (name, args) => { calls.push({ name, args }); return name === names[0] ? current : sendResult; }, close: async () => {} };
  const store = new Store(':memory:'), broker = new Broker(store, new Map([[providerId, provider]]), { clients: { alice: { providers: [providerId] } } });
  t.after(async () => { await broker.close(); store.close(); });
  return { store, broker, calls, setState: value => current = value };
}
const input = { id: 'native-fixture', text: 'A source-observed event occurred.', requestId: 'notification-fixture-1' };

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

test('a retried notification reuses its first disposition and a changed intent conflicts', async t => {
  const f = await fixture(t, 'codex', { latestTurn: { status: 'inProgress' } });
  const first = await f.broker.notify('alice', 'codex', input);
  await Promise.all(f.broker.running.values());
  assert.equal(f.calls[1].args.mode, 'steer');
  f.setState({ latestTurn: { status: 'completed' } });
  const again = await f.broker.notify('alice', 'codex', input);
  assert.equal(again.operation.id, first.operation.id);
  assert.equal(f.calls.length, 2, 'recovery cannot resend after the destination becomes idle');
  await assert.rejects(f.broker.notify('alice', 'codex', { ...input, text: 'different intent' }), { code: 'conflict' });
  assert.equal(f.calls.length, 2);
});

test('a failed, unknown or malformed native status never dispatches a follow-up', async t => {
  const f = await fixture(t, 'codex', { isError: true, structuredContent: { error: { code: 'unavailable' } } });
  await assert.rejects(f.broker.notify('alice', 'codex', input), { code: 'status_unavailable' });
  for (const [index, value] of [{}, { latestTurn: { status: 'mystery' } }, { status: 'rejected', error: { code: 'refused' } }].entries()) {
    f.setState(value);
    await assert.rejects(f.broker.notify('alice', 'codex', { ...input, requestId: `unknown-state-${index}` }), { code: 'status_unavailable' });
  }
  assert.equal(f.calls.filter(call => call.name === 'codex_send').length, 0);
  assert.equal(f.store.list('alice').length, 0);
});

test('an Antigravity destination receives a prompt, and a busy one yields a failed receipt rather than a dropped message', async t => {
  const f = await fixture(t, 'antigravity', null, { sessionId: input.id, status: 'rejected',
    error: { code: 'turn_active', message: 'A turn this broker started is still running.' } });
  const receipt = await f.broker.notify('alice', 'antigravity', input);
  await Promise.all(f.broker.running.values());
  assert.deepEqual(f.calls.map(call => call.name), ['antigravity_prompt']);
  assert.deepEqual(f.calls[0].args, { sessionId: input.id, text: input.text });
  assert.equal(f.store.get('alice', receipt.operation.id).status, 'failed');
});
