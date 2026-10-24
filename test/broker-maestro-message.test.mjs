import test from 'node:test';
import assert from 'node:assert/strict';
import { Broker } from '../src/broker.mjs';
import { Store } from '../src/store.mjs';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fixture(t) {
  const calls = [], store = new Store(':memory:');
  const provider = { descriptor: { id: 'maestro', availability: 'ready' },
    catalog: [{ name: 'maestro_send', annotations: { readOnlyHint: false } }],
    call: async (name, args) => {
      calls.push({ name, args });
      // Maestro ingress accepts string IDs; its message emitter requires UUID
      // v4. This boundary deliberately models that later native validation.
      assert.match(args.clientMessageId, uuidV4, 'native Maestro emitter requires a UUID v4 message ID');
      return { status: 'accepted', messageId: args.clientMessageId };
    }, close: async () => {} };
  const broker = new Broker(store, new Map([['maestro', provider]]), {
    clients: { alice: { providers: ['maestro'] }, bob: { providers: ['maestro'] } },
  });
  t.after(async () => { await broker.close(); store.close(); });
  return { broker, store, calls };
}
const input = { id: 'native-session-fixture', text: 'Controlled fixture only', requestId: 'arbitrary-logical-request-1' };
async function send(f, caller, args = input, operation = 'sessions.message') {
  const result = await f.broker.operate(caller, 'maestro', operation, args);
  await Promise.all([...f.broker.running.values()]);
  assert.equal(f.store.get(caller, result.operation.id).status, 'succeeded');
  return result;
}

test('Maestro native UUID message IDs are deterministic, caller scoped and retain the original mutation identity', async t => {
  const f = fixture(t);
  const first = await send(f, 'alice');
  const duplicate = await send(f, 'alice');
  assert.equal(duplicate.operation.id, first.operation.id);
  assert.equal(f.calls.length, 1);
  const aliceId = f.calls[0].args.clientMessageId;
  assert.match(aliceId, uuidV4);
  assert.equal(f.calls[0].args.mutation.requestId, input.requestId);
  await send(f, 'bob');
  assert.notEqual(f.calls[1].args.clientMessageId, aliceId);
  await send(f, 'alice', { ...input, requestId: 'another-logical-request-1' }, 'sessions.steer');
  assert.match(f.calls[2].args.clientMessageId, uuidV4);
  assert.notEqual(f.calls[2].args.clientMessageId, aliceId);
  await assert.rejects(f.broker.operate('alice', 'maestro', 'sessions.message', { ...input, text: 'Changed intent' }), { code: 'conflict' });
  assert.equal(f.calls.length, 3, 'conflicting content is not sent');
  const fresh = fixture(t);
  await send(fresh, 'alice');
  assert.equal(fresh.calls[0].args.clientMessageId, aliceId, 'derivation is stable without process-local randomness');
  const otherTarget = fixture(t);
  await send(otherTarget, 'alice', { ...input, id: 'different-native-session' });
  assert.notEqual(otherTarget.calls[0].args.clientMessageId, aliceId);
});

test('previously settled writes retain their stored native ID and are never silently converted or replayed', async t => {
  const f = fixture(t);
  const legacyArgs = { action: 'message', target: { connectionId: 'maestro', kind: 'session', id: input.id },
    mutation: { requestId: input.requestId }, intent: 'new_turn', text: input.text, clientMessageId: input.requestId };
  const { operation } = f.store.submit('alice', input.requestId, 'maestro', { name: 'maestro_send', args: legacyArgs, context: {} });
  f.store.transition('alice', operation.id, ['queued'], 'dispatching');
  f.store.transition('alice', operation.id, ['dispatching'], 'failed', { error: 'native UUID rejection' });
  f.broker.recover();
  await Promise.all([...f.broker.running.values()]);
  await assert.rejects(f.broker.operate('alice', 'maestro', 'sessions.message', input), { code: 'conflict' });
  assert.equal(f.store.get('alice', operation.id).request.args.clientMessageId, input.requestId);
  assert.equal(f.store.get('alice', operation.id).status, 'failed');
  assert.equal(f.calls.length, 0);
});
