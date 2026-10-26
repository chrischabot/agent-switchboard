import test from 'node:test';
import assert from 'node:assert/strict';
import { Broker } from '../src/broker.mjs';
import { McpProvider } from '../src/providers.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function fixture(providers, timeout = 1000, grants = Object.keys(providers)) {
  return new Broker(null, new Map(Object.entries(providers)), {
    clients: { test: { providers: grants } }, agentRefreshTimeoutMs: timeout,
  });
}
function provider(refresh) {
  return { descriptor: { availability: 'offline', observedAt: 'old' }, catalog: [], refresh };
}

test('agent discovery runs concurrently, shares in-flight probes, and checks again on the next request', async () => {
  const release = deferred(), bothStarted = deferred();
  let started = 0;
  const probe = async function () {
    if (++started === 2) bothStarted.resolve();
    await release.promise;
    this.descriptor.availability = 'ready';
  };
  const broker = fixture({ a: provider(probe), b: provider(probe) });
  const first = broker.agents('test'), second = broker.agents('test');
  await bothStarted.promise;
  assert.equal(started, 2);
  release.resolve();
  for (const result of await Promise.all([first, second]))
    assert.deepEqual(result.map(p => [p.availability, p.freshness]), [['ready', 'fresh'], ['ready', 'fresh']]);
  await broker.agents('test');
  assert.equal(started, 4);
});

test('a stalled provider is unknown, preserves old evidence and cannot cause overlapping reconnects', async () => {
  const release = deferred();
  let attempts = 0;
  const broker = fixture({ slow: provider(async () => { attempts++; await release.promise; }),
    healthy: provider(async function () { this.descriptor.availability = 'ready'; }) }, 20);
  try {
    for (let i = 0; i < 2; i++) {
      const [slow, healthy] = await broker.agents('test');
      assert.equal(slow.availability, 'unknown');
      assert.equal(slow.freshness, 'stale');
      assert.equal(slow.refreshError, 'refresh_timeout');
      assert.equal(slow.observedAt, 'old');
      assert.ok(slow.checkedAt);
      assert.equal(healthy.availability, 'ready');
      assert.equal(healthy.freshness, 'fresh');
    }
    assert.equal(attempts, 1);
  } finally { release.resolve(); }
});

test('failed probes do not leak errors or preserve stale ready status, and only granted providers are checked', async () => {
  const bad = provider(async () => { throw new Error('private credential'); });
  bad.descriptor.availability = 'ready';
  const auth = provider(async () => { throw Object.assign(new Error('private token'), { code: 'auth_required' }); });
  let forbiddenCalls = 0;
  const broker = fixture({ bad, auth, forbidden: provider(async () => { forbiddenCalls++; }) }, 1000, ['bad', 'auth']);
  const result = await broker.agents('test');
  assert.deepEqual(result.map(p => p.availability), ['unknown', 'auth_required']);
  assert.deepEqual(result.map(p => p.refreshError), ['refresh_failed', 'auth_required']);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(forbiddenCalls, 0);
  await assert.rejects(broker.agents('stranger'), /Unknown client/);
});

test('native discovery pings an existing client without reconnecting or closing it', async () => {
  const p = new McpProvider('fabric', {});
  let pings = 0;
  p.client = { async ping() { pings++; }, async close() { assert.fail('live client closed'); } };
  p.connect = async () => assert.fail('live client reconnected');
  const broker = fixture({ fabric: p });
  for (let i = 0; i < 2; i++) {
    const [result] = await broker.agents('test');
    assert.equal(result.availability, 'ready');
    assert.equal(result.freshness, 'fresh');
    assert.ok(result.observedAt);
  }
  assert.equal(pings, 2);
});

test('disconnected native provider reconnects, then subsequent discovery uses ping', async () => {
  const p = new McpProvider('maestro', {});
  let connects = 0, pings = 0;
  p.connect = async () => {
    connects++;
    p.client = { async ping() { pings++; } };
    p.descriptor.availability = 'ready';
  };
  const broker = fixture({ maestro: p });
  assert.equal((await broker.agents('test'))[0].availability, 'ready');
  assert.equal((await broker.agents('test'))[0].availability, 'ready');
  assert.equal(connects, 1);
  assert.equal(pings, 1);
});

test('a connection closing during a ping is not reported ready', async () => {
  const p = new McpProvider('fabric', {});
  p.client = { async ping() { p.client = null; p.descriptor.availability = 'offline'; } };
  const [result] = await fixture({ fabric: p }).agents('test');
  assert.equal(result.availability, 'unknown');
  assert.equal(result.refreshError, 'refresh_failed');
});
