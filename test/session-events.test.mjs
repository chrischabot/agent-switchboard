import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, writeFile, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { once, EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Broker } from '../src/broker.mjs';
import { SessionEvents, normalizeSessionEvent } from '../src/session-events.mjs';
import { watchJsonLines } from '../src/local-event-source.mjs';
import { Events } from '../src/events.mjs';

const terminal = { name: 'session.turn.ended', sourceId: 'native-sequence-1', turnId: 'turn-1', scope: 'turn', outcome: 'completed' };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'switchboard-session-events-'));
  const store = new Store(path.join(directory, 'state.sqlite')), calls = [], sources = new Map();
  const types = ['session.turn.ended', 'session.error', 'session.source.gap'];
  const source = { close: async () => {}, descriptor: { id: 'claude', availability: 'ready' }, catalog: [], sessionEventTypes: types,
    watchSession: async (id, options) => { sources.set(id, options); return async () => sources.delete(id); } };
  const target = { close: async () => {}, descriptor: { id: 'codex', availability: 'ready' }, catalog: [
    { name: 'codex_send', annotations: { readOnlyHint: false } }, { name: 'codex_read', annotations: { readOnlyHint: true } }],
    call: async (name, args) => { if (name === 'codex_read') return { latestTurn: { status: 'completed' } };
      calls.push({ name, args }); return { state: 'owner-accepted' }; } };
  const config = { clients: { alice: { providers: ['codex', 'claude'] }, bob: { providers: ['claude'] } } };
  const broker = new Broker(store, new Map([['claude', source], ['codex', target]]), config);
  const events = broker.sessionEvents = new SessionEvents(broker);
  t.after(async () => { await events.close(); await broker.close(); store.close(); await rm(directory, { recursive: true }); });
  async function flush() {
    for (let i = 0; i < 20 && (events.deliveries.size || broker.running.size); i++)
      await Promise.all([...events.deliveries.values(), ...broker.running.values()]);
  }
  return { directory, store, broker, events, source, sources, calls, flush };
}

test('receipt, optimistic activity, tool errors and partial output cannot manufacture turn completion', () => {
  for (const raw of [{ name: 'task_end' }, { name: 'state', payload: { status: 'ready' } },
    { name: 'state', payload: { status: 'paused' } }, { name: 'new_message', payload: { type: 'tool', status: 'error' } }])
    assert.equal(normalizeSessionEvent('maestro', raw, '1').some(e => e.name === 'session.turn.ended'), false);
  const codex = normalizeSessionEvent('codex', { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { id: 'cmd', type: 'commandExecution', status: 'failed' } } }, '2');
  assert.deepEqual(codex.map(e => [e.name, e.scope]), [['session.block.completed', 'block'], ['session.error', 'block']]);
  const ended = normalizeSessionEvent('codex', { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }, '3');
  assert.equal(ended[0].outcome, 'ended');
  assert.equal(ended[0].turnId, 'turn-1');
});

test('Claude repeated end_turn blocks wait for the final host boundary and retain distinct block identities', () => {
  const state = {};
  const base = { type: 'assistant', message: { id: 'response-1', stop_reason: 'end_turn' } };
  assert.deepEqual(normalizeSessionEvent('claude', { ...base, apiBlockIndex: 0, message: { ...base.message, content: [{ type: 'thinking' }] } }, 'line-1', state), []);
  const block = normalizeSessionEvent('claude', { ...base, apiBlockIndex: 1, message: { ...base.message, content: [{ type: 'text', text: 'private text' }] } }, 'line-2', state);
  assert.equal(block.length, 1); assert.equal(block[0].blockId, 'response-1:1');
  assert.equal(JSON.stringify(block).includes('private text'), false);
  assert.deepEqual(normalizeSessionEvent('claude', { type: 'system', subtype: 'stop_hook_summary', preventedContinuation: true }, 'line-3', state), []);
  assert.deepEqual(normalizeSessionEvent('claude', { type: 'system', subtype: 'stop_hook_summary', preventedContinuation: false }, 'blocked-continuation', state), []);
  normalizeSessionEvent('claude', { ...base, apiBlockIndex: 1, message: { ...base.message, content: [{ type: 'text' }] } }, 'continued-response', state);
  const end = normalizeSessionEvent('claude', { type: 'system', subtype: 'stop_hook_summary', preventedContinuation: false }, 'line-4', state);
  assert.deepEqual(end.map(e => e.name), ['session.turn.ended']);
  assert.equal(end[0].turnId, 'response-1');
  assert.deepEqual(normalizeSessionEvent('claude', { type: 'system', subtype: 'stop_hook_summary', preventedContinuation: false }, 'line-5', state), []);
});

test('native Fabric event metadata preserves the exact turn and failed status without parsing clipped previews', () => {
  const end = normalizeSessionEvent('fabric', { sequence: 4, eventType: 'conversation.turn_ended', event: { turnId: 'old-turn', status: 'failed' } }, '4');
  assert.equal(end[0].turnId, 'old-turn'); assert.equal(end[0].outcome, 'failed');
  assert.equal(end[1].name, 'session.error'); assert.equal(end[1].scope, 'turn');
  const block = normalizeSessionEvent('fabric', { eventType: 'presentation.block_completed', event: { block: { blockId: 'nested-block', blockKind: 'tool_result' } } }, '6');
  assert.equal(block[0].blockId, 'nested-block'); assert.equal(block[0].blockType, 'tool_result');
  const unknown = normalizeSessionEvent('fabric', { type: 'conversation.turn_ended', turnId: 'exact', preview: '{"status":"completed"' }, '5');
  assert.equal(unknown[0].outcome, 'ended');
});

test('durable watches deduplicate native replay, preserve cursors and separate caller journals', async t => {
  const f = await fixture(t);
  const a = await f.events.watch('alice', { provider: 'claude', sessionId: 'fixture-source' });
  const w = f.events.load(a.watchId);
  f.events.record(w, [terminal, terminal], { nativeCursor: 12 });
  f.events.record(w, [terminal], { nativeCursor: 13 });
  assert.equal(f.store.events('alice').events.length, 1);
  assert.equal(f.store.events('bob').events.length, 0);
  assert.deepEqual(f.events.load(a.watchId).cursor, { nativeCursor: 13 });
  await assert.rejects(f.events.unwatch('bob', a.watchId), { code: 'not_found' });
  await assert.rejects(f.events.watch('bob', { provider: 'codex', sessionId: 'foreign' }), { code: 'forbidden' });
  await f.events.unwatch('alice', a.watchId);
  f.events.record(w, [{ ...terminal, sourceId: 'after-unsubscribe' }]);
  assert.equal(f.store.events('alice').events.length, 1);
});

test('follow-ups are one-shot by default, deduplicated across replay, and preserve native receipts', async t => {
  const f = await fixture(t);
  const args = { provider: 'claude', sessionId: 'fixture-source', events: ['session.turn.ended'],
    notify: { provider: 'codex', sessionId: 'fixture-target' }, requestId: 'follow-fixture-1' };
  const follow = await f.events.follow('alice', args);
  await f.events.follow('alice', args);
  await assert.rejects(f.events.follow('alice', { ...args, maxDeliveries: 2 }), { code: 'conflict' });
  const w = f.events.load((await f.events.watch('alice', args)).watchId);
  f.events.record(w, [terminal, terminal, { ...terminal, sourceId: 'native-sequence-2' }]);
  await f.flush();
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].args.text.includes('turn-1'));
  const result = f.events.unfollow('alice', follow.followId);
  assert.equal(result.deliveriesRequested, 1);
  assert.equal(result.completionScope, 'notification_dispatch');
  assert.equal(f.store.get('alice', result.operationId).status, 'succeeded');
  await assert.rejects(f.events.follow('alice', { ...args, sessionId: 'fixture-target', provider: 'codex', requestId: 'self-follow' }), { code: 'unsupported' });
});

test('webhook event types filter exact source, session and turn and retain signed event identity', async t => {
  const f = await fixture(t), delivered = [];
  const hooks = new Events(f.broker, { send: async (_s, id, body) => {
    const value = JSON.parse(body);
    if (value.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: value.challenge }) };
    delivered.push({ id, value }); return { status: 204 };
  } });
  t.after(() => hooks.close());
  const params = { name: 'session.turn.ended', arguments: { provider: 'claude', sessionId: 'fixture-source', turnId: 'turn-1' },
    delivery: { mode: 'webhook', url: 'https://receiver.example/events', secret: `whsec_${Buffer.alloc(32, 1).toString('base64')}` } };
  await hooks.subscribe('alice', params);
  const w = f.events.load((await f.events.watch('alice', { provider: 'claude', sessionId: 'fixture-source' })).watchId);
  f.events.record(w, [{ ...terminal, sourceId: 'other-turn', turnId: 'turn-2' }, terminal]);
  for (let i = 0; i < 10 && hooks.running.size; i++) await Promise.all([...hooks.running.values()]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].value.name, 'session.turn.ended');
  assert.equal(delivered[0].value.data.turnId, 'turn-1');
  assert.ok(delivered[0].value.data.journalCursor > 0);
  assert.equal(delivered[0].id, delivered[0].value.eventId);
});

test('real JSONL append notifications keep partial lines uncommitted and resume without replaying history', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'switchboard-tail-')), file = path.join(directory, 'native.jsonl');
  await writeFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'historical' } }) + '\n');
  const signal = new EventEmitter(), received = []; let cursor, close;
  const observe = (events, next) => { received.push(...events); cursor = next; if (events.length) signal.emit('event'); };
  t.after(async () => { await close?.(); await rm(directory, { recursive: true }); });
  close = await watchJsonLines(file, 'codex', { onEvent: observe, onError: () => assert.fail('Native source failed') });
  assert.equal(received.length, 0);
  const row = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'live-turn' } });
  await appendFile(file, row.slice(0, 15));
  const done = once(signal, 'event', { signal: AbortSignal.timeout(2000) });
  await appendFile(file, row.slice(15) + '\n'); await done;
  assert.equal(received.length, 1); assert.equal(received[0].turnId, 'live-turn');
  await close();
  close = await watchJsonLines(file, 'codex', { cursor, onEvent: observe, onError: () => assert.fail('Native source failed') });
  assert.equal(received.length, 1);
});

test('external appends and appends after atomic log replacement remain observable', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'switchboard-external-tail-'));
  const file = path.join(directory, 'native.jsonl'), replacement = path.join(directory, 'replacement.jsonl');
  await writeFile(file, '');
  const signal = new EventEmitter(), received = [];
  const close = await watchJsonLines(file, 'codex', { onEvent: events => {
    received.push(...events);
    for (const event of events) if (event.turnId) signal.emit(event.turnId);
  }, onError: () => assert.fail('Native source failed') });
  t.after(async () => { await close(); await rm(directory, { recursive: true }); });
  const append = turn => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import {appendFileSync} from "node:fs";appendFileSync(process.argv[1],process.argv[2]);', file,
      JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:turn}}) + '\n']);
    assert.equal(result.status, 0);
  };
  const first = once(signal, 'external-one', { signal: AbortSignal.timeout(3000) });
  append('external-one'); await first;
  const replaced = once(signal, 'replacement-two', { signal: AbortSignal.timeout(3000) });
  await writeFile(replacement, JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'replacement-two'}}) + '\n');
  await rename(replacement, file); await replaced;
  const third = once(signal, 'external-three', { signal: AbortSignal.timeout(3000) });
  append('external-three'); await third;
  assert.deepEqual(received.filter(e => e.name === 'session.turn.ended').map(e => e.turnId),
    ['external-one', 'replacement-two', 'external-three']);
  assert.equal(received.filter(e => e.name === 'session.source.gap').length, 1);
});

test('Maestro ongoing completion-check summaries do not end a turn; exact terminal footer state does', () => {
  const base = { name: 'update_message', payload: { id: 'assistant-message', type: 'assistant_message',
    metadata: { turnSummary: { turnId: 'opening-event-id', state: 'ongoing', reason: 'completion_check' } } } };
  assert.equal(normalizeSessionEvent('maestro', base, '1').some(e => e.name === 'session.turn.ended'), false);
  const completed = structuredClone(base); completed.payload.metadata.turnSummary.state = 'complete';
  const events = normalizeSessionEvent('maestro', completed, '2');
  assert.equal(events[0].name, 'session.turn.ended'); assert.equal(events[0].turnId, 'opening-event-id');
  const failed = structuredClone(base); failed.payload.metadata.turnSummary.state = 'error';
  assert.ok(normalizeSessionEvent('maestro', failed, '3').some(e => e.name === 'session.error' && e.scope === 'turn'));
});
