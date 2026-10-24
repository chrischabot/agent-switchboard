import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Store } from '../src/store.mjs';
import { Broker } from '../src/broker.mjs';
import { Events } from '../src/events.mjs';
import { serveHub } from '../src/http.mjs';
import { callbackUrl, publicAddress, secretKey, signedHeaders, postWebhook } from '../src/webhooks.mjs';

// Standards oracle: https://developers.openai.com/plugins/build/mcp-events
// Store, Broker, Events and signing are real. Only the HTTPS receiver boundary
// is controlled; no webhook is sent to an external service or live agent.
const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const replacementSecret = `whsec_${Buffer.alloc(32, 19).toString('base64')}`;
const callback = 'https://receiver.example/events';
const baseTime = 1_800_000_000_000;
const subscription = (extra = {}) => ({ name: 'operation.changed', arguments: {},
  delivery: { mode: 'webhook', url: callback, secret }, ...extra });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-events-test-'));
  const filename = path.join(directory, 'events.sqlite');
  const calls = [], releases = [];
  let clock = baseTime, count = 0;
  let application = options.application ?? (() => ({ status: 204, body: '' }));
  let verification = options.verification ?? (event => ({ status: 200, body: JSON.stringify({ challenge: event.challenge }) }));
  const config = { clients: { alice: { providers: ['codex', 'claude'] }, bob: { providers: ['codex'] } } };
  let store, broker, events;
  function open() {
    store = new Store(filename);
    broker = new Broker(store, new Map([['codex', {}], ['claude', {}]]), config);
    events = new Events(broker, { now: () => clock, send: async (s, id, body) => {
      const event = JSON.parse(body);
      const call = { subscription: structuredClone(s), id, body, event, headers: signedHeaders(s, id, body, clock) };
      calls.push(call);
      return event.type === 'verification' ? verification(event, call) : application(event, call);
    } });
    broker.events = events;
  }
  open();
  t.after(async () => {
    for (const release of releases) release({ status: 204, body: '' });
    await events.close(); store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    calls, config, filename,
    get store() { return store; }, get broker() { return broker; }, get events() { return events; }, get now() { return clock; },
    advance(ms) { clock += ms; },
    setApplication(fn) { application = fn; }, setVerification(fn) { verification = fn; },
    hold() { const gate = defer(); releases.push(gate.resolve); return gate; },
    data() { return calls.filter(call => call.event.type !== 'verification'); },
    verifyCalls() { return calls.filter(call => call.event.type === 'verification'); },
    operation(principal = 'alice', provider = 'codex') {
      return store.submit(principal, `events-fixture-${++count}`, provider, { fixture: count }).operation;
    },
    async flush() {
      // Drain promises created by kicks, including a pending kick after refresh.
      for (let round = 0; round < 20 && events.running.size; round++) await Promise.all([...events.running.values()]);
      assert.equal(events.running.size, 0, 'delivery did not settle');
    },
    async reopen() { await events.close(); store.close(); open(); events.start(); },
  };
}

async function withHttp(f, run) {
  const tokens = { alice: 'alice-events-wire-fixture-'.repeat(3), bob: 'bob-events-wire-fixture-'.repeat(3) };
  for (const [caller, token] of Object.entries(tokens)) {
    const tokenFile = path.join(path.dirname(f.filename), `${caller}.token`);
    await writeFile(tokenFile, token, { mode: 0o600 });
    f.config.clients[caller].tokenFile = tokenFile;
  }
  const service = await serveHub(f.broker, { port: 0 });
  let nextId = 0;
  async function rpc(method, params = {}, caller = 'alice') {
    const id = ++nextId;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tokens[caller] ?? 'unconfigured-token'}`, 'mcp-protocol-version': '2026-07-28', 'mcp-method': method };
    if (params.name) headers['mcp-name'] = params.name;
    const response = await fetch(`http://127.0.0.1:${service.port}/mcp`, { method: 'POST', headers,
      signal: AbortSignal.timeout(5000), body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'events-wire-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
    });
    const text = await response.text();
    const body = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(message => message.id === id)
      : text ? JSON.parse(text) : undefined;
    return { status: response.status, body };
  }
  try { await run(rpc); } finally { await service.close(); }
}

function rpcResult(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body?.error, undefined, JSON.stringify(response.body));
  return response.body.result;
}

test('public callback address policy excludes private, local, reserved and mixed IPv6 destinations', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:8.8.8.8', '2001:db8::1', '2002:7f00:1::', 'not-an-ip']) {
    assert.equal(publicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])
    assert.equal(publicAddress(address), true, address);
  for (const url of ['http://receiver.example', 'https://u:p@receiver.example', 'https://receiver.example:8443',
    'https://receiver.example/#fragment', 'file:///tmp/receiver', 'not-a-url'])
    assert.throws(() => callbackUrl(url), { code: 'invalid_callback' });
  assert.equal(callbackUrl('https://receiver.example:443/events').href, callback);
});

test('Standard Webhooks signatures cover exact UTF-8 bytes and enforce key and rotation boundaries', () => {
  const body = '{ "eventId": "fixture-1", "text": "café\\n☃" }';
  const s = { id: 'sub-1', secret, previousSecret: replacementSecret, rotateUntil: baseTime + 1000 };
  const headers = signedHeaders(s, 'fixture-1', body, baseTime);
  assert.equal(headers['webhook-id'], 'fixture-1');
  assert.equal(headers['webhook-timestamp'], String(baseTime / 1000));
  assert.equal(headers['X-MCP-Subscription-Id'], 'sub-1');
  const expected = [secret, replacementSecret].map(key => 'v1,' + createHmac('sha256', Buffer.from(key.slice(6), 'base64'))
    .update(Buffer.from(`fixture-1.${baseTime / 1000}.${body}`, 'utf8')).digest('base64')).join(' ');
  assert.equal(headers['webhook-signature'], expected);
  assert.notEqual(signedHeaders(s, 'fixture-1', JSON.stringify(JSON.parse(body)), baseTime)['webhook-signature'], expected);
  assert.equal(signedHeaders(s, 'fixture-1', body, baseTime + 1000)['webhook-signature'].split(' ').length, 1);
  assert.notEqual(signedHeaders(s, 'fixture-1', body, baseTime + 1000)['webhook-signature'], expected);
  for (const bytes of [24, 64]) assert.equal(secretKey(`whsec_${Buffer.alloc(bytes, 3).toString('base64')}`).length, bytes);
  for (const bad of ['', 'whsec_bad!', `whsec_${Buffer.alloc(23).toString('base64')}`,
    `whsec_${Buffer.alloc(65).toString('base64')}`, 'plain-secret', null])
    assert.throws(() => secretKey(bad), { code: 'invalid_secret' });
});

test('HTTPS sender resolves each connection, pins DNS, preserves hostname and refuses redirects and oversized bodies', async t => {
  let addresses = [{ address: '8.8.8.8', family: 4 }];
  const resolutions = [], sent = [];
  t.mock.method(dns, 'lookup', async (hostname, options) => { resolutions.push({ hostname, options }); return addresses; });
  t.mock.method(https, 'request', (url, options, onResponse) => {
    const req = new EventEmitter();
    req.end = body => {
      sent.push({ url, options, body });
      const response = new EventEmitter();
      response.statusCode = 302;
      response.headers = { location: 'https://127.0.0.1/secrets' };
      queueMicrotask(() => { onResponse(response); response.emit('data', Buffer.from('redirect')); response.emit('end'); });
    };
    return req;
  });
  syncBuiltinESMExports();
  try {
    const s = { id: 'dns-sub', url: callback, secret };
    assert.equal((await postWebhook(s, 'event-1', '{"text":"café"}')).status, 302);
    assert.equal(sent.length, 1, 'must not follow redirect');
    assert.equal(sent[0].url.hostname, 'receiver.example', 'TLS must authenticate original hostname');
    assert.equal(sent[0].options.agent, false);
    assert.equal(sent[0].body, '{"text":"café"}');
    const pinned = await new Promise((resolve, reject) => sent[0].options.lookup('receiver.example', {},
      (error, address, family) => error ? reject(error) : resolve({ address, family })));
    assert.deepEqual(pinned, addresses[0]);
    addresses = [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
    await assert.rejects(postWebhook(s, 'event-2', '{}'), { code: 'invalid_callback' });
    addresses = [];
    await assert.rejects(postWebhook(s, 'event-3', '{}'), { code: 'invalid_callback' });
    addresses = [{ address: '2606:4700:4700::1111', family: 6 }];
    await postWebhook(s, 'event-4', '{}');
    assert.equal(sent.length, 2);
    assert.equal(resolutions.length, 4, 'each verification or delivery must revalidate DNS');
    assert.ok(resolutions.every(x => x.hostname === 'receiver.example' && x.options.all === true));
    await assert.rejects(postWebhook(s, 'too-large', 'é'.repeat(131073)), { code: 'payload_too_large' });
    assert.equal(resolutions.length, 4, 'oversized body must fail before DNS or HTTPS');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('verification gates activation; bad challenges and timeouts never send application data', async t => {
  const f = await fixture(t);
  f.operation();
  const params = subscription({ cursor: '0' });
  f.setVerification(() => ({ status: 200, body: '{"challenge":"wrong"}' }));
  await assert.rejects(f.events.subscribe('alice', params), { code: -32015, data: { reason: 'challenge_failed' } });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 0);
  assert.equal(f.data().length, 0);
  f.setVerification(() => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); });
  await assert.rejects(f.events.subscribe('alice', params), { code: -32015, data: { reason: 'timeout' } });
  assert.equal(f.data().length, 0);
  f.setVerification(event => ({ status: 200, body: JSON.stringify({ challenge: event.challenge }) }));
  const accepted = await f.events.subscribe('alice', params);
  await f.flush();
  assert.equal(f.data().length, 1);
  assert.equal(f.data()[0].headers['X-MCP-Subscription-Id'], accepted.id);
  const challenges = f.verifyCalls();
  assert.equal(new Set(challenges.map(x => x.id)).size, 3);
  assert.equal(new Set(challenges.map(x => x.event.challenge)).size, 3);
  assert.ok(challenges.every(x => x.headers['webhook-signature'].startsWith('v1,')));
});

test('subscription identity is canonical, principal scoped and refresh cannot jump unacknowledged events', async t => {
  const f = await fixture(t, { application: () => ({ status: 503 }) });
  const op = f.operation();
  const params = subscription({ cursor: '0', arguments: { provider: 'codex', operationId: op.id } });
  const first = await f.events.subscribe('alice', params);
  await f.flush();
  assert.equal(f.events.load(first.id).cursor, 0);
  const latest = f.store.events('alice').nextCursor;
  const renewed = await f.events.subscribe('alice', { ...params, cursor: String(latest), arguments: { operationId: op.id, provider: 'codex' } });
  await f.flush();
  assert.equal(renewed.id, first.id);
  assert.equal(renewed.cursor, '0');
  assert.equal(f.verifyCalls().length, 1, 'same principal and callback reuse bounded verification');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 1);
  const bob = await f.events.subscribe('bob', subscription());
  assert.notEqual(bob.id, first.id);
  const before = f.calls.length;
  await assert.rejects(f.events.subscribe('bob', params), { code: 'not_found' });
  await assert.rejects(f.events.subscribe('bob', subscription({ arguments: { provider: 'claude' } })), { code: 'forbidden' });
  await assert.rejects(f.events.subscribe('unknown', subscription()), { code: 'unauthorized' });
  await assert.rejects(f.events.subscribe('alice', subscription({ cursor: String(latest + 1) })), { code: 'invalid_cursor' });
  assert.equal(f.calls.length, before, 'unauthorized or ahead-of-journal requests never verify a callback');
});

test('durable delivery filters principal, provider and operation and stops on revoked access', async t => {
  const f = await fixture(t);
  const wanted = f.operation('alice', 'codex');
  f.operation('bob', 'codex');
  f.operation('alice', 'claude');
  f.operation('alice', 'codex');
  f.store.transition('alice', wanted.id, ['queued'], 'completed', { secretNativeOutput: 'not in webhook' });
  const sub = await f.events.subscribe('alice', subscription({ cursor: '0', arguments: { provider: 'codex', operationId: wanted.id } }));
  await f.flush();
  assert.deepEqual(f.data().map(call => call.event.data.status), ['queued', 'completed']);
  assert.ok(f.data().every(call => call.event.data.operationId === wanted.id));
  assert.ok(f.data().every(call => !call.body.includes('secretNativeOutput')));
  assert.ok(f.data().every(call => call.id === call.event.eventId && call.event.name === 'operation.changed'));
  const cursors = f.data().map(call => call.event.data.journalCursor);
  assert.ok(cursors[1] > cursors[0]);
  f.config.clients.alice.providers = ['claude'];
  f.operation('alice', 'codex');
  await f.flush();
  assert.equal(f.events.load(sub.id).state, 'revoked');
  assert.equal(f.data().length, 2);
});

test('transient retries preserve event identity and body, use new signatures and stop after five attempts', async t => {
  const f = await fixture(t, { application: () => ({ status: 503 }) });
  const sub = await f.events.subscribe('alice', subscription());
  await f.flush();
  f.operation();
  await f.flush();
  for (const delay of [1000, 2000, 4000, 8000]) {
    const before = f.events.load(sub.id);
    assert.equal(before.state, 'active');
    assert.equal(before.nextAt - f.now, delay);
    assert.equal(before.cursor, 0);
    f.advance(delay);
    f.events.kick(sub.id);
    await f.flush();
  }
  assert.equal(f.events.load(sub.id).state, 'failed');
  assert.equal(f.data().length, 5);
  assert.equal(new Set(f.data().map(call => call.id)).size, 1);
  assert.equal(new Set(f.data().map(call => call.body)).size, 1);
  assert.equal(new Set(f.data().map(call => call.headers['webhook-signature'])).size, 5);
  f.advance(60000); f.events.kick(sub.id); await f.flush();
  assert.equal(f.data().length, 5);
});

test('acknowledgment advances replay cursor and permanent rejections do not retry', async t => {
  const f = await fixture(t);
  const sub = await f.events.subscribe('alice', subscription());
  await f.flush();
  const op = f.operation();
  await f.flush();
  const last = f.store.events('alice').nextCursor;
  assert.equal(f.events.load(sub.id).cursor, last);
  await f.reopen(); await f.flush();
  assert.equal(f.data().length, 1, 'acknowledged event does not replay on restart');
  for (const status of [410, 413, 403]) {
    f.setApplication(() => ({ status }));
    const p = subscription({ delivery: { mode: 'webhook', url: `${callback}/${status}`, secret }, arguments: { operationId: op.id } });
    const rejection = await f.events.subscribe('alice', p);
    await f.flush();
    f.store.transition('alice', op.id, ['queued', 'completed'], 'completed', {});
    await f.flush();
    const count = f.data().filter(call => call.subscription.id === rejection.id).length;
    assert.equal(count, 1);
    assert.equal(f.events.load(rejection.id).state, 'failed');
    f.advance(60000); f.events.kick(rejection.id); await f.flush();
    assert.equal(f.data().filter(call => call.subscription.id === rejection.id).length, count);
  }
});

test('unsubscribe while a delivery is in flight cannot be undone by its acknowledgment', async t => {
  const f = await fixture(t);
  const sub = await f.events.subscribe('alice', subscription());
  await f.flush();
  const blocked = f.hold(), entered = defer();
  f.setApplication(() => { entered.resolve(); return blocked.promise; });
  f.operation(); await entered.promise;
  assert.deepEqual(f.events.unsubscribe('alice', subscription()), {});
  blocked.resolve({ status: 204 }); await f.flush();
  assert.equal(f.events.load(sub.id), undefined);
  f.operation(); await f.flush();
  assert.equal(f.data().length, 1);
});

test('secret rotation during delivery resumes the pending event under the new revision without another journal write', async t => {
  const f = await fixture(t);
  const sub = await f.events.subscribe('alice', subscription()); await f.flush();
  const blocked = f.hold(), entered = defer();
  let first = true;
  f.setApplication(() => { if (first) { first = false; entered.resolve(); return blocked.promise; } return { status: 204 }; });
  f.operation(); await entered.promise;
  const rotated = await f.events.subscribe('alice', subscription({ delivery: { mode: 'webhook', url: callback, secret: replacementSecret } }));
  assert.equal(rotated.id, sub.id);
  blocked.resolve({ status: 204 }); await f.flush();
  assert.equal(f.data().length, 2);
  assert.equal(f.data()[0].id, f.data()[1].id);
  assert.equal(f.data()[1].subscription.secret, replacementSecret);
  assert.equal(f.data()[1].headers['webhook-signature'].split(' ').length, 2);
  assert.equal(f.events.load(sub.id).cursor, f.store.events('alice').nextCursor);
});

test('a same-clock cursor rewind is not overwritten by an older in-flight acknowledgment', async t => {
  const f = await fixture(t);
  const sub = await f.events.subscribe('alice', subscription()); await f.flush();
  f.operation(); await f.flush();
  const firstId = f.data()[0].id;
  const blocked = f.hold(), entered = defer();
  let first = true;
  f.setApplication(() => { if (first) { first = false; entered.resolve(); return blocked.promise; } return { status: 204 }; });
  f.operation(); await entered.promise;
  const secondId = f.data()[1].id;
  const replay = await f.events.subscribe('alice', subscription({ cursor: '0' }));
  assert.equal(replay.id, sub.id);
  assert.equal(replay.cursor, '0');
  blocked.resolve({ status: 204 }); await f.flush();
  assert.deepEqual(f.data().map(call => call.id), [firstId, secondId, firstId, secondId]);
});

test('idempotent refresh during secret rotation retains both signing keys until the window expires', async t => {
  const f = await fixture(t);
  await f.events.subscribe('alice', subscription()); await f.flush();
  const params = subscription({ delivery: { mode: 'webhook', url: callback, secret: replacementSecret } });
  const rotated = await f.events.subscribe('alice', params); await f.flush();
  f.advance(1000);
  await f.events.subscribe('alice', params); await f.flush();
  f.operation(); await f.flush();
  assert.equal(f.data()[0].headers['webhook-signature'].split(' ').length, 2);
  assert.equal(f.events.load(rotated.id).previousSecret, secret);
  f.advance(300000);
  f.operation(); await f.flush();
  assert.equal(f.data()[1].headers['webhook-signature'].split(' ').length, 1);
});

test('expiration stops delivery and a refresh preserves the event missed while expired', async t => {
  const f = await fixture(t);
  const sub = await f.events.subscribe('alice', subscription({ ttlMs: 1000 })); await f.flush();
  assert.equal(Date.parse(sub.refreshBefore), baseTime + 1000);
  f.advance(1000); f.operation(); await f.flush();
  assert.equal(f.data().length, 0);
  const resumed = await f.events.subscribe('alice', subscription({ ttlMs: 1000 })); await f.flush();
  assert.equal(resumed.id, sub.id);
  assert.equal(f.data().length, 1);
  assert.equal(f.events.load(sub.id).cursor, f.store.events('alice').nextCursor);
});

test('SIGKILL before acknowledgment replays the same durable event and cursor after restart', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-events-crash-'));
  const filename = path.join(directory, 'events.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `
    const { Store } = await import(${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)});
    const { Broker } = await import(${JSON.stringify(new URL('../src/broker.mjs', import.meta.url).href)});
    const { Events } = await import(${JSON.stringify(new URL('../src/events.mjs', import.meta.url).href)});
    const store = new Store(${JSON.stringify(filename)});
    const broker = new Broker(store, new Map(), { clients: { alice: { providers: ['codex'] } } });
    const events = new Events(broker, { send: async (s,id,body) => {
      const event = JSON.parse(body);
      if (event.type === 'verification') return { status:200,body:JSON.stringify({challenge:event.challenge}) };
      process.send({ id, body, subscriptionId:s.id });
      return new Promise(() => {});
    } });
    await events.subscribe('alice', ${JSON.stringify(subscription())});
    store.submit('alice','crash-event-once','codex',{});
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const [before] = await once(child, 'message');
  const closed = once(child, 'close'); child.kill('SIGKILL');
  const [, signal] = await closed;
  assert.equal(signal, 'SIGKILL', stderr);
  const store = new Store(filename);
  const broker = new Broker(store, new Map(), { clients: { alice: { providers: ['codex'] } } });
  const received = [];
  const events = new Events(broker, { send: async (s, id, body) => { received.push({ id, body, subscriptionId: s.id }); return { status: 204 }; } });
  try {
    assert.equal(events.load(before.subscriptionId).cursor, 0);
    events.start(); await Promise.all([...events.running.values()]);
    assert.deepEqual(received, [before]);
    assert.equal(events.load(before.subscriptionId).cursor, Number(JSON.parse(before.body).cursor));
    events.kick(before.subscriptionId); await Promise.all([...events.running.values()]);
    assert.equal(received.length, 1);
  } finally { await events.close(); store.close(); }
});

test('actual authenticated MCP HTTP discovers, subscribes, filters and unsubscribes events', async t => {
  const f = await fixture(t);
  const wanted = f.operation('alice', 'codex');
  f.operation('alice', 'claude');
  await withHttp(f, async rpc => {
    const discovery = rpcResult(await rpc('server/discover'));
    assert.deepEqual(discovery.capabilities.events, {});
    const listed = rpcResult(await rpc('events/list'));
    assert.equal(listed.events.length, 1);
    assert.equal(listed.events[0].name, 'operation.changed');
    assert.deepEqual(listed.events[0].delivery, ['webhook']);
    assert.deepEqual(listed.events[0].payloadSchema.required, ['operationId', 'provider', 'status', 'journalCursor']);
    const params = subscription({ cursor: '0', ttlMs: 60000, arguments: { provider: 'codex' } });
    const created = rpcResult(await rpc('events/subscribe', params));
    await f.flush();
    assert.equal(created.truncated, false);
    assert.equal(Date.parse(created.refreshBefore), baseTime + 60000);
    assert.equal(created.cursor, '0');
    assert.deepEqual(f.events.load(created.id).arguments, { provider: 'codex' });
    assert.equal(f.events.load(created.id).url, callback);
    assert.equal(f.events.load(created.id).secret, secret);
    assert.deepEqual(f.data().map(call => call.event.data.operationId), [wanted.id]);
    const remove = { name: params.name, arguments: params.arguments, delivery: { mode: 'webhook', url: callback } };
    rpcResult(await rpc('events/unsubscribe', remove, 'bob'));
    assert.ok(f.events.load(created.id), 'another principal cannot unsubscribe the owner');
    assert.equal((await rpc('events/subscribe', params, 'unconfigured')).status, 401);
    const refreshed = rpcResult(await rpc('events/subscribe', { ...params, cursor: String(f.store.events('alice').nextCursor) }));
    await f.flush();
    assert.equal(refreshed.id, created.id);
    assert.equal(f.verifyCalls().length, 1);
    assert.equal(f.data().length, 1);
    for (let repeat = 0; repeat < 2; repeat++) {
      const { resultType, _meta, ...payload } = rpcResult(await rpc('events/unsubscribe', remove));
      assert.equal(resultType, 'complete');
      assert.deepEqual(payload, {});
    }
    assert.equal(f.events.load(created.id), undefined);
    f.operation('alice', 'codex'); await f.flush();
    assert.equal(f.data().length, 1);
  });
});

for (const reason of ['challenge_failed', 'timeout']) {
  test(`actual MCP HTTP preserves CallbackEndpointError ${reason} and never activates delivery`, async t => {
    const f = await fixture(t, { verification: reason === 'timeout'
      ? () => { throw Object.assign(new Error('fixture timeout'), { name: 'AbortError' }); }
      : () => ({ status: 200, body: '{"challenge":"wrong"}' }) });
    f.operation();
    await withHttp(f, async rpc => {
      const response = await rpc('events/subscribe', subscription({ cursor: '0' }));
      assert.equal(response.body?.error?.code, -32015, JSON.stringify(response.body));
      assert.equal(response.body.error.data.reason, reason);
      assert.equal(f.data().length, 0);
      assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 0);
    });
  });
}
