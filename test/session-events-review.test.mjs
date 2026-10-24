import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Store, fingerprint } from '../src/store.mjs';
import { Broker } from '../src/broker.mjs';
import { SessionEvents, normalizeSessionEvent } from '../src/session-events.mjs';

const end = (id, turnId = id) => ({ name: 'session.turn.ended', sourceId: id, turnId, scope: 'turn', outcome: 'completed' });
const watchArgs = { provider: 'claude', sessionId: 'source-fixture' };
const followArgs = { ...watchArgs, events: ['session.turn.ended'], notify: { provider: 'codex', sessionId: 'target-fixture' }, requestId: 'review-follow-identity' };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { filename = ':memory:', setup, targetConnect } = {}) {
  const store = new Store(filename), sources = [], calls = [];
  const config = { clients: { alice: { providers: ['claude', 'codex'] }, bob: { providers: ['claude', 'codex'] } } };
  const source = { descriptor: { id: 'claude', availability: 'ready' }, catalog: [],
    sessionEventTypes: ['session.turn.ended', 'session.block.completed', 'session.source.gap'], close: async () => {},
    watchSession: async (id, options) => {
      const entry = { id, ...options, closed: 0 }; sources.push(entry);
      await setup?.(entry);
      return async () => { entry.closed++; };
    } };
  const target = { descriptor: { id: 'codex', availability: targetConnect ? 'offline' : 'ready' },
    catalog: [{ name: 'codex_send', annotations: { readOnlyHint: false } }, { name: 'codex_read', annotations: { readOnlyHint: true } }], close: async () => {},
    ...(targetConnect ? { connect: targetConnect } : {}),
    call: async (name, args) => {
      if (name === 'codex_read') return { latestTurn: { status: 'completed' } };
      calls.push({ name, args }); return { state: 'owner-accepted' };
    } };
  const broker = new Broker(store, new Map([['claude', source], ['codex', target]]), config);
  let events = broker.sessionEvents = new SessionEvents(broker);
  t.after(async () => { await events.close(); await broker.close(); store.close(); });
  return { store, broker, config, source, target, sources, calls, get events() { return events; },
    async restart() { await events.close(); events = broker.sessionEvents = new SessionEvents(broker); await events.start(); },
    async flush() {
      for (let attempt = 0; attempt < 50; attempt++) {
        await tick();
        if (!events.deliveries.size && !broker.running.size) return;
        await Promise.all([...events.deliveries.values(), ...broker.running.values()]);
      }
      assert.fail('Event work did not quiesce after 50 observed completion boundaries');
    } };
}

test('concurrent refreshes own one source and preserve the longest expiry', async t => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, { setup: () => gate.promise });
  const first = f.events.watch('alice', { ...watchArgs, ttlMs: 10000 });
  const second = f.events.watch('alice', { ...watchArgs, ttlMs: 60000 });
  await tick(); gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(f.sources.length, 1, 'Concurrent requests must share pending source setup');
  assert.equal(a.watchId, b.watchId);
  assert.ok(Date.parse(a.expiresAt) > Date.now() + 50000);
  await f.events.unwatch('alice', a.watchId);
  assert.equal(f.sources[0].closed, 1);
});

test('a cold follow establishes one owned source and discovers capabilities before registration', async t => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, { setup: async () => {
    await gate.promise;
    f.source.sessionEventTypes = ['session.turn.ended'];
    f.source.descriptor.availability = 'ready';
  } });
  f.source.descriptor.availability = 'offline';
  f.source.sessionEventTypes = [];
  assert.equal(f.events.catalog('alice')[1].providers[0].support, 'unknown');
  const first = f.events.follow('alice', followArgs);
  const second = f.events.follow('alice', followArgs);
  await tick(); gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.followId, b.followId);
  assert.equal(f.sources.length, 1);
  f.sources[0].onEvent([end('cold-native-turn')], 1);
  await f.flush();
  assert.equal(f.calls.length, 1);
});

test('cold discovery refuses an unsupported follow without retaining its request identity', async t => {
  const f = await fixture(t, { setup: () => {
    f.source.sessionEventTypes = ['session.block.completed'];
    f.source.descriptor.availability = 'ready';
  } });
  f.source.descriptor.availability = 'offline';
  f.source.sessionEventTypes = [];
  await assert.rejects(f.events.follow('alice', followArgs), { code: 'unsupported' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM event_follows').get().n, 0);
  assert.equal(f.calls.length, 0);
});

test('a desktop file source can follow while native command discovery is offline', async t => {
  const f = await fixture(t);
  f.source.descriptor.availability = 'offline';
  const follow = await f.events.follow('alice', followArgs);
  assert.equal(follow.state, 'active');
  assert.equal(f.sources.length, 1);
  f.sources[0].onEvent([end('offline-discovery-live-file')], 1);
  await f.flush();
  assert.equal(f.calls.length, 1);
});

for (const action of ['unwatch', 'close']) test(`${action} during setup closes the eventual source without resurrection`, async t => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, { setup: () => gate.promise });
  const watching = f.events.watch('alice', watchArgs).catch(error => error);
  await tick();
  const id = fingerprint(['alice', watchArgs.provider, watchArgs.sessionId]);
  const stopping = action === 'close' ? f.events.close() : f.events.unwatch('alice', id);
  gate.resolve(); await stopping;
  const result = await watching;
  assert.equal(result.code, 'cancelled');
  assert.equal(f.sources[0].closed, 1, 'The close handle returned after cancellation must still be called');
  f.sources[0].onEvent([end('late')], { offset: 999 });
  assert.equal(f.store.events('alice').events.length, 0);
});

test('callbacks from an old generation cannot corrupt replacement events or cursor', async t => {
  const f = await fixture(t);
  const a = await f.events.watch('alice', watchArgs);
  const stale = f.sources[0];
  await f.events.unwatch('alice', a.watchId);
  const replacement = await f.events.watch('alice', watchArgs);
  f.sources[1].onEvent([end('new')], { offset: 10 });
  stale.onEvent([end('stale')], { offset: 999 }); stale.onError();
  assert.deepEqual(f.store.events('alice').events.filter(e => e.topic.startsWith('session.')).map(e => e.data.turnId), ['new']);
  assert.equal(f.events.status('alice', replacement.watchId).status, 'watching');
  assert.deepEqual(f.events.status('alice', replacement.watchId).cursor, { offset: 10 });
});

test('a setup-time source failure remains visible and a retry resumes its last cursor', async t => {
  let count = 0;
  const f = await fixture(t, { setup: source => {
    if (count++ === 0) { source.onEvent([], 'durable-cursor'); source.onError(); }
  } });
  const a = await f.events.watch('alice', watchArgs);
  assert.equal(a.status, 'failed');
  assert.equal(f.events.status('alice', a.watchId).cursor, 'durable-cursor');
  await f.events.watch('alice', watchArgs);
  assert.equal(f.sources[0].closed, 1);
  assert.equal(f.sources[1].cursor, 'durable-cursor');
});

test('caller status and callbacks remain isolated when source and target names coincide', async t => {
  const f = await fixture(t);
  const a = await f.events.watch('alice', watchArgs), b = await f.events.watch('bob', watchArgs);
  f.sources[0].onEvent([end('native-1')], 1); f.sources[1].onEvent([end('native-1')], 1);
  assert.equal(f.store.events('alice').events.length, 1); assert.equal(f.store.events('bob').events.length, 1);
  assert.throws(() => f.events.status('bob', a.watchId), { code: 'not_found' });
  await assert.rejects(f.events.unwatch('bob', a.watchId), { code: 'not_found' });
  assert.equal(f.events.status('bob', b.watchId).cursor, 1);
  const follow = await f.events.follow('alice', followArgs, { privateContext: 'not-public' });
  assert.throws(() => f.events.followStatus('bob', follow.followId), { code: 'not_found' });
  assert.equal(JSON.stringify(f.events.followStatus('alice', follow.followId)).includes('not-public'), false);
  f.config.clients.alice.providers = ['codex'];
  f.sources[0].onEvent([end('revoked')], 2);
  await f.flush();
  assert.equal(f.store.events('alice').events.filter(e => e.topic.startsWith('session.')).length, 1);
  assert.equal(f.calls.length, 0, 'Revoked observation must not drive another provider');
});

test('cancelling while dispatch awaits a downstream connection cannot be overwritten', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { targetConnect: async () => { entered.resolve(); await release.promise; } });
  const follow = await f.events.follow('alice', { ...followArgs, maxDeliveries: 3 });
  f.sources[0].onEvent([end('one')], 1);
  await entered.promise;
  f.events.unfollow('alice', follow.followId);
  release.resolve(); await f.flush();
  f.sources[0].onEvent([end('two')], 2); await f.flush();
  assert.equal(f.events.followStatus('alice', follow.followId).state, 'cancelled');
  assert.equal(f.calls.length, 1, 'Cancellation allows the already initiated dispatch only');
});

test('a follow drains a finite journal backlog beyond one page and then becomes idle', async t => {
  const f = await fixture(t);
  await f.events.follow('alice', followArgs); await f.flush();
  for (let i = 0; i < 425; i++) f.store.append('alice', 'unrelated', 'other', {});
  f.sources[0].onEvent([end('after-backlog')], 1);
  await f.flush();
  assert.equal(f.calls.length, 1);
  await tick(); await tick();
  assert.equal(f.events.deliveries.size, 0); assert.equal(f.events.pendingDeliveries.size, 0);
});

test('saved watch cursor plus exact turn filter includes an already observed completion', async t => {
  const f = await fixture(t);
  const watch = await f.events.watch('alice', watchArgs);
  const after = f.events.status('alice', watch.watchId).journalCursor;
  f.sources[0].onEvent([end('wrong', 'another-turn'), end('expected-native', 'accepted-turn')], 'next');
  const follow = await f.events.follow('alice', { ...followArgs, after, turnId: 'accepted-turn' });
  await f.flush();
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].args.text.includes('accepted-turn'));
  assert.equal(f.calls[0].args.text.includes('another-turn'), false);
  const status = f.events.followStatus('alice', follow.followId);
  assert.equal(status.state, 'complete'); assert.equal(status.turnId, 'accepted-turn');
  assert.equal(status.operation.status, 'succeeded');
});

test('invalid follow scope, replay cursor or lifetime never consumes a durable identity', async t => {
  const f = await fixture(t);
  for (const invalid of [{ ttlMs: 0 }, { ttlMs: '1000' }, { sessionId: '' }, { turnId: {} },
    { after: -1 }, { after: 0.5 }, { after: 1 }, { notify: { provider: 'codex', sessionId: {} } }]) {
    await assert.rejects(f.events.follow('alice', { ...followArgs, ...invalid }), error => ['invalid_arguments', 'invalid_cursor'].includes(error.code));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM event_follows').get().n, 0);
  }
  assert.equal(f.sources.length, 0);
});

test('restart resumes exact source cursor and retains native logical event deduplication', async t => {
  const f = await fixture(t);
  const watch = await f.events.watch('alice', watchArgs);
  f.sources[0].onEvent([end('source-sequence-1', 'same-turn')], { offset: 10 });
  await f.restart();
  assert.deepEqual(f.sources[1].cursor, { offset: 10 });
  f.sources[1].onEvent([end('source-sequence-2', 'same-turn'), end('source-sequence-3', 'next-turn')], { offset: 20 });
  assert.equal(f.store.events('alice').events.length, 2);
  assert.deepEqual(f.events.status('alice', watch.watchId).cursor, { offset: 20 });
});

test('Claude continuation clears an obsolete final response before a later stop hook', () => {
  const state = {};
  const text = { type: 'assistant', message: { id: 'old-response', stop_reason: 'end_turn', content: [{ type: 'text' }] } };
  normalizeSessionEvent('claude', text, '1', state);
  normalizeSessionEvent('claude', { type: 'user', message: { content: [{ type: 'text', text: 'continue' }] } }, '2', state);
  assert.deepEqual(normalizeSessionEvent('claude', { type: 'system', subtype: 'stop_hook_summary', preventedContinuation: false }, '3', state), []);
});

test('shutdown also awaits a source whose unwatch was already waiting for setup', async t => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, { setup: () => gate.promise });
  const watching = f.events.watch('alice', watchArgs).catch(error => error);
  await tick();
  const stopping = f.events.unwatch('alice', fingerprint(['alice', watchArgs.provider, watchArgs.sessionId]));
  let closed = false;
  const shutdown = f.events.close().then(() => { closed = true; });
  await tick();
  const returnedBeforeSource = closed;
  gate.resolve(); await Promise.all([watching, stopping, shutdown]);
  assert.equal(returnedBeforeSource, false, 'Shutdown cannot allow the database to close before a pending source teardown');
  assert.equal(f.sources[0].closed, 1);
});

test('follow revocation is enforced while replaying already durable source events', async t => {
  const f = await fixture(t);
  const follow = await f.events.follow('alice', followArgs); await f.flush();
  f.store.append('alice', 'session.turn.ended', watchArgs.sessionId,
    { ...end('previously-observed'), ...watchArgs });
  f.config.clients.alice.providers = ['codex'];
  await f.events.deliverFollows('alice'); await f.flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.followStatus('alice', follow.followId).state, 'revoked');
});

test('a process crash after native dispatch cannot resend that follow notification on restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'switchboard-event-crash-'));
  const filename = path.join(directory, 'state.sqlite');
  const script = `
    import { Store } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
    import { Broker } from ${JSON.stringify(new URL('../src/broker.mjs', import.meta.url).href)};
    import { SessionEvents } from ${JSON.stringify(new URL('../src/session-events.mjs', import.meta.url).href)};
    const store = new Store(${JSON.stringify(filename)}); let sourceCallback;
    const source = {descriptor:{availability:'ready'},catalog:[],sessionEventTypes:['session.turn.ended'],
      watchSession:async (_id, options) => {sourceCallback=options;return async()=>{};}};
    const target = {descriptor:{availability:'ready'},catalog:[{name:'codex_send',annotations:{readOnlyHint:false}},{name:'codex_read',annotations:{readOnlyHint:true}}],
      call:async(name)=>{if(name==='codex_read')return {latestTurn:{status:'completed'}};process.exit(23);}};
    const broker=new Broker(store,new Map([['claude',source],['codex',target]]),{clients:{alice:{providers:['claude','codex']}}});
    const events=new SessionEvents(broker);
    await events.follow('alice',${JSON.stringify(followArgs)});
    sourceCallback.onEvent([${JSON.stringify(end('crash-boundary'))}], 'native-cursor-1');
    await events.deliverFollows('alice');
    process.exit(24);
  `;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(crashed.status, 23, crashed.stderr);
  const f = await fixture(t, { filename });
  t.after(() => rm(directory, { recursive: true }));
  assert.equal(f.store.db.prepare('SELECT status FROM operations').get().status, 'dispatching');
  f.store.recover();
  await f.events.start(); await f.flush();
  const status = f.events.followStatus('alice', fingerprint(['alice', followArgs.requestId]));
  assert.equal(f.calls.length, 0, 'An uncertain pre-crash native write must never be repeated automatically');
  assert.equal(status.operation.status, 'outcome_unknown');
  assert.equal(status.deliveriesRequested, 1);
  assert.equal(status.completionScope, 'notification_dispatch');
  assert.equal(f.sources[0].cursor, 'native-cursor-1');
});

test('expired durable watches of a removed caller cannot abort startup', async t => {
  const f = await fixture(t);
  const watch = await f.events.watch('alice', watchArgs);
  await f.events.close();
  // A prior process may have stopped before the persisted expiry timer fired.
  f.store.db.prepare("UPDATE session_watches SET body=json_set(body,'$.expiresAt',0) WHERE id=?").run(watch.watchId);
  delete f.config.clients.alice;
  await f.restart();
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM session_watches').get().n, 0);
  assert.equal(f.sources.length, 1);
});

test('a concurrent refresh while startup restores a source cannot lose its extended expiry', async t => {
  const gate = Promise.withResolvers(); let setups = 0;
  const f = await fixture(t, { setup: () => ++setups === 2 ? gate.promise : undefined });
  await f.events.watch('alice', { ...watchArgs, ttlMs: 10000 });
  const restarting = f.restart(); await tick();
  const refreshing = f.events.watch('alice', { ...watchArgs, ttlMs: 60000 });
  gate.resolve(); await restarting;
  const watch = await refreshing;
  assert.ok(Date.parse(f.events.status('alice', watch.watchId).expiresAt) > Date.now() + 50000);
  assert.equal(f.sources.length, 2);
});

test('completed follow identities do not exhaust active capacity and the thirty-third active follow is refused', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 32; index++) {
    await f.events.follow('alice', { ...followArgs, requestId: `completed-follow-${index}` });
    f.sources[0].onEvent([end(`finished-${index}`)], index + 1);
    await f.flush();
  }
  assert.equal(f.calls.length, 32);
  for (let index = 0; index < 32; index++)
    await f.events.follow('alice', { ...followArgs, requestId: `active-follow-${index}` });
  const sourcesBefore = f.sources.length;
  await assert.rejects(f.events.follow('alice', { ...followArgs, requestId: 'over-active-capacity' }), { code: 'follow_limit' });
  assert.equal(f.sources.length, sourcesBefore);
  assert.equal(f.calls.length, 32, 'Capacity rejection must not dispatch a new native message');
  const first = await f.events.follow('alice', { ...followArgs, requestId: 'completed-follow-0' });
  assert.equal(first.state, 'complete'); assert.equal(first.deliveriesRequested, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM event_follows').get().n, 64, 'All prior request identities survive the active-capacity check');
});
