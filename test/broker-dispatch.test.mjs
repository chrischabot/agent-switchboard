import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Broker } from '../src/broker.mjs';
import { Store } from '../src/store.mjs';

const wrap = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const nativeFailure = { ...wrap({ error: { code: 'UPSTREAM_ERROR', message: 'Controlled upstream failure' } }), isError: true };

// Claim: a dispatch receipt describes the provider response faithfully through
// the MCP/broker envelopes, persists it, and never retries an uncertain write.
// Boundary fixture: only downstream provider execution is replaced. The real
// Broker and SQLite Store own dispatch, classification, recovery and replay.
async function exercise(t, response, expectedStatus) {
  const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-dispatch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'state.sqlite');
  const config = { clients: { caller: { providers: ['fixture'] } } };
  let calls = 0;
  const provider = { descriptor: { id: 'fixture', availability: 'ready' },
    catalog: [{ name: 'fixture_write', annotations: { readOnlyHint: false } }],
    call: async () => { calls++; return response; }, close: async () => {} };
  let store = new Store(filename);
  let broker = new Broker(store, new Map([['fixture', provider]]), config);
  t.after(async () => { await broker.close(); store.close(); });
  const args = { fixtureId: 'owned-disposable-fixture', text: 'Test boundary only' };
  const first = await broker.invoke('caller', 'fixture', 'fixture_write', args, 'same-logical-dispatch');
  await Promise.all([...broker.running.values()]);
  const completed = store.get('caller', first.operation.id);
  assert.equal(completed.status, expectedStatus);
  assert.deepEqual(completed.result, response, 'the exact native evidence survives classification');
  const duplicate = await broker.invoke('caller', 'fixture', 'fixture_write', args, 'same-logical-dispatch');
  assert.equal(duplicate.operation.id, first.operation.id);
  assert.equal(duplicate.operation.status, expectedStatus);
  assert.equal(calls, 1);
  await broker.close();
  store.close();
  store = new Store(filename);
  broker = new Broker(store, new Map([['fixture', provider]]), config);
  broker.recover();
  await Promise.all([...broker.running.values()]);
  assert.equal(store.get('caller', first.operation.id).status, expectedStatus);
  assert.equal(calls, 1, 'recovery does not replay settled or uncertain dispatches');
}

test('native failures persist as failed through supported result envelopes', async t => {
  for (const [name, response] of [
    ['native MCP isError', nativeFailure],
    ['nested hub complete result', { resultType: 'complete', ...wrap({ kind: 'result', value: nativeFailure }) }],
    ['structured native error without isError', wrap({ error: { code: 'UPSTREAM_ERROR' } })],
    ['text-encoded native error', { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'UPSTREAM_ERROR' } }) }] }],
    ['explicit failed result', wrap({ status: 'failed' })],
    ['Fabric admission refused', wrap({ operationId: 'op_fixture', action: 'thread.start',
      accepted: false, observed: 'not_accepted', result: { accepted: false } })],
    ['completed downstream dispatch with failed native result', wrap({ kind: 'operation', operation: { id: 'downstream-operation', status: 'succeeded', result: nativeFailure } })],
  ]) await t.test(name, child => exercise(child, response, 'failed'));
});

test('unsettled downstream delivery remains unknown even through successful outer envelopes', async t => {
  for (const [name, response] of [
    ['direct native unknown marked isError', { ...wrap({ status: 'outcome_unknown' }), isError: true }],
    ['nested native transport sent', wrap({ kind: 'result', value: wrap({ state: 'transport-sent' }) })],
    ['nested pending dispatch receipt', wrap({ kind: 'operation', operation: { id: 'downstream-operation', status: 'dispatching' } })],
    ['Fabric uncertain cancel receipt', wrap({ operationId: 'op_fixture', action: 'thread.cancel',
      accepted: false, observed: 'uncertain', result: { accepted: false } })],
  ]) await t.test(name, child => exercise(child, response, 'outcome_unknown'));
});

test('successful results containing historical error data still succeed', async t => {
  await exercise(t, wrap({ status: 'accepted', data: { error: { code: 'HISTORICAL_ERROR' } },
    messages: [{ isError: true, status: 'failed' }] }), 'succeeded');
});

test('an already-terminal Fabric turn is a completed stop despite accepted false', async t => {
  await exercise(t, wrap({ operationId: 'op_fixture', action: 'thread.cancel', accepted: false,
    observed: 'already_terminal', result: { accepted: false, outcome: 'already_terminal' } }), 'succeeded');
});
