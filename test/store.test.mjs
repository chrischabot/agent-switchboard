import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { Store } from '../src/store.mjs';

const storeModule = new URL('../src/store.mjs', import.meta.url).href;
const alice = 'test:alice';
const bob = 'test:bob';
const request = { action: 'message', target: 'fixture-session', text: 'fixture nonce' };

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-store-test-'));
  const filename = path.join(directory, 'store.sqlite');
  const stores = new Set();
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    filename,
    open() { const store = new Store(filename); stores.add(store); return store; },
    close(store) { store.close(); stores.delete(store); },
  };
}

// Real independent SQLite connections cross the barrier together. No mock
// supplies the deduplication or transition outcome under test.
async function concurrent(t, filename, action, count = 6) {
  const gate = new SharedArrayBuffer(4);
  const workers = Array.from({ length: count }, () => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { Store } = await import(workerData.module);
      const store = new Store(workerData.filename);
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      try {
        const value = workerData.action.kind === 'submit'
          ? store.submit(workerData.action.principal, workerData.action.key,
              workerData.action.provider, workerData.action.request)
          : store.transition(workerData.action.principal, workerData.action.id,
              ['queued'], 'dispatching');
        parentPort.postMessage({ value });
      } finally { store.close(); }
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { module: storeModule, filename, gate, action } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  const ready = [];
  const results = [];
  for (const worker of workers) {
    let resolveReady, rejectReady, resolveResult, rejectResult;
    ready.push(new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }));
    results.push(new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; }));
    worker.on('message', message => message.ready ? resolveReady() : resolveResult(message.value));
    worker.on('error', error => { rejectReady(error); rejectResult(error); });
    worker.on('exit', code => {
      if (code !== 0) {
        const error = new Error(`SQLite worker exited with ${code}`);
        rejectReady(error); rejectResult(error);
      }
    });
  }
  // Attach rejection handlers before waiting for the initialization barrier.
  const finished = Promise.all(results);
  finished.catch(() => {});
  await Promise.all(ready);
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  return finished;
}

test('a retry keeps its durable identity; changed payload or provider conflicts without another event', async t => {
  const f = await fixture(t);
  let store = f.open();
  const first = store.submit(alice, 'request-retry-1', 'codex', request);
  assert.equal(first.fresh, true);
  assert.equal(first.operation.status, 'queued');
  store.transition(alice, first.operation.id, ['queued'], 'completed', { receipt: 'native-1' });
  f.close(store);
  store = f.open();
  const retry = store.submit(alice, 'request-retry-1', 'codex', {
    text: request.text, target: request.target, action: request.action,
  });
  assert.equal(retry.fresh, false);
  assert.equal(retry.operation.id, first.operation.id);
  assert.equal(retry.operation.status, 'completed');
  assert.deepEqual(retry.operation.result, { receipt: 'native-1' });
  assert.throws(() => store.submit(alice, 'request-retry-1', 'codex', {
    ...request, text: 'different instruction',
  }), { code: 'conflict' });
  assert.throws(() => store.submit(alice, 'request-retry-1', 'claude', request), { code: 'conflict' });
  assert.equal(store.list(alice).length, 1);
  assert.deepEqual(store.events(alice).events.map(event => event.topic), [
    'operation.queued', 'operation.completed',
  ]);
});

test('simultaneous submissions and dispatch claims admit exactly one winner', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const store = f.open();
  const submitted = await concurrent(t, f.filename, {
    kind: 'submit', principal: alice, key: 'parallel-request-1', provider: 'maestro', request,
  });
  assert.equal(submitted.filter(result => result.fresh).length, 1);
  const ids = new Set(submitted.map(result => result.operation.id));
  assert.equal(ids.size, 1);
  const [id] = ids;
  const claimed = await concurrent(t, f.filename, { kind: 'claim', principal: alice, id });
  assert.equal(claimed.filter(Boolean).length, 1);
  assert.equal(store.get(alice, id).status, 'dispatching');
  assert.deepEqual(store.events(alice).events.map(event => event.topic), [
    'operation.queued', 'operation.dispatching',
  ]);
});

test('principals cannot read, transition, replay or answer each other\'s objects', async t => {
  const f = await fixture(t);
  const store = f.open();
  const a = store.submit(alice, 'shared-request-key', 'fabric', request).operation;
  const b = store.submit(bob, 'shared-request-key', 'fabric', request).operation;
  assert.notEqual(a.id, b.id);
  assert.throws(() => store.get(bob, a.id), { code: 'not_found' });
  assert.throws(() => store.transition(bob, a.id, ['queued'], 'completed'), { code: 'not_found' });
  assert.deepEqual(store.list(alice).map(operation => operation.id), [a.id]);
  assert.deepEqual(store.list(bob).map(operation => operation.id), [b.id]);
  const question = store.ask(alice, a.id, { message: 'Select a fixture colour' });
  assert.throws(() => store.question(bob, question), { code: 'not_found' });
  assert.throws(() => store.answer(bob, question, { action: 'accept', content: { colour: 'red' } }),
    { code: 'not_found' });
  assert.equal(store.question(alice, question).response, null);
  assert.equal(store.get(alice, a.id).status, 'queued');
  assert.deepEqual(store.events(bob).events.map(event => event.object_id), [b.id]);
  assert.ok(store.events(alice).events.every(event => event.principal === alice));
});

test('after a killed broker, recovery preserves queued work and marks interrupted dispatch unknown once',
  { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const script = `
      const { Store } = await import(${JSON.stringify(storeModule)});
      const store = new Store(${JSON.stringify(f.filename)});
      const queued = store.submit('test:alice', 'crash-queued-1', 'codex', {}).operation.id;
      const active = store.submit('test:alice', 'crash-active-1', 'claude', {}).operation.id;
      const complete = store.submit('test:alice', 'crash-complete-1', 'fabric', {}).operation.id;
      const other = store.submit('test:bob', 'crash-other-1', 'maestro', {}).operation.id;
      store.transition('test:alice', active, ['queued'], 'dispatching');
      store.transition('test:alice', complete, ['queued'], 'completed', { receipt: 'retained' });
      store.transition('test:bob', other, ['queued'], 'dispatching');
      process.stdout.write(JSON.stringify({ queued, active, complete, other }),
        () => process.kill(process.pid, 'SIGKILL'));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(exit.signal, 'SIGKILL', stderr);
    const ids = JSON.parse(stdout);
    const store = f.open();
    assert.equal(store.get(alice, ids.active).status, 'dispatching');
    assert.deepEqual(store.recover().map(operation => operation.id), [ids.queued]);
    assert.equal(store.get(alice, ids.active).status, 'outcome_unknown');
    assert.equal(store.get(bob, ids.other).status, 'outcome_unknown');
    assert.deepEqual(store.get(alice, ids.complete).result, { receipt: 'retained' });
    assert.equal(store.get(alice, ids.complete).status, 'completed');
    assert.deepEqual(store.recover().map(operation => operation.id), [ids.queued]);
    const interrupted = store.events(alice).events.filter(event => event.topic === 'operation.outcome_unknown');
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].object_id, ids.active);
    assert.equal(store.submit(alice, 'crash-active-1', 'claude', {}).operation.status, 'outcome_unknown');
  });

test('event replay is durable, ordered, exclusive and principal scoped across journal gaps', async t => {
  const f = await fixture(t);
  let store = f.open();
  const a = store.submit(alice, 'journal-alice-1', 'codex', request).operation;
  store.submit(bob, 'journal-bob-1', 'maestro', request);
  store.transition(alice, a.id, ['queued'], 'dispatching');
  const question = store.ask(alice, a.id, { message: 'Continue fixture?' });
  store.answer(alice, question, { action: 'decline' });
  f.close(store);
  store = f.open();
  const replay = [];
  let cursor = 0;
  for (;;) {
    const page = store.events(alice, { after: cursor, limit: 2 });
    assert.ok(page.events.length <= 2);
    assert.ok(page.events.every(event => event.seq > cursor && event.principal === alice));
    replay.push(...page.events);
    if (page.events.length === 0) {
      assert.equal(page.nextCursor, cursor);
      break;
    }
    assert.equal(page.nextCursor, page.events.at(-1).seq);
    cursor = page.nextCursor;
  }
  assert.deepEqual(replay.map(event => event.topic), [
    'operation.queued', 'operation.dispatching', 'question.created', 'question.answered',
  ]);
  assert.deepEqual(replay.map(event => event.object_id), [a.id, a.id, question, question]);
  assert.equal(new Set(replay.map(event => event.seq)).size, replay.length);
  assert.ok(replay.slice(1).every((event, index) => event.seq > replay[index].seq));
  assert.equal(store.events(alice, { after: cursor }).events.length, 0);
  for (const after of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, '0']) {
    assert.throws(() => store.events(alice, { after }), { code: 'invalid_cursor' });
  }
});

test('bounded operation and event pages never omit or repeat records when resumed', async t => {
  const f = await fixture(t);
  const store = f.open();
  const ids = new Set();
  for (let index = 0; index < 205; index++) {
    ids.add(store.submit(alice, `bounded-request-${index}`, 'fabric', { index }).operation.id);
  }
  assert.equal(store.list(alice).length, 50);
  assert.equal(store.events(alice).events.length, 100);
  for (const limit of [0, 1, 200, 1000]) {
    const bound = limit < 1 ? 1 : Math.min(limit, 200);
    assert.equal(store.list(alice, { limit }).length, bound);
    assert.equal(store.events(alice, { limit }).events.length, bound);
  }
  const first = store.list(alice, { limit: 200 });
  const second = store.list(alice, { after: first.at(-1).id, limit: 200 });
  assert.equal(second.length, 5);
  assert.deepEqual(new Set([...first, ...second].map(operation => operation.id)), ids);
  assert.equal(store.list(alice, { after: second.at(-1).id }).length, 0);
  const events = store.events(alice, { limit: 200 });
  const more = store.events(alice, { after: events.nextCursor, limit: 200 });
  assert.equal(more.events.length, 5);
  assert.deepEqual(new Set([...events.events, ...more.events].map(event => event.object_id)), ids);
});

test('question answers survive reopening; identical retries are harmless and changed answers conflict', async t => {
  const f = await fixture(t);
  let store = f.open();
  const operation = store.submit(alice, 'question-request-1', 'maestro', request).operation;
  const questionRequest = { message: 'Choose fixture settings', requestedSchema: { type: 'object' } };
  const id = store.ask(alice, operation.id, questionRequest);
  const response = { action: 'accept', content: { colour: 'blue', size: 2 } };
  store.answer(alice, id, response);
  f.close(store);
  store = f.open();
  assert.deepEqual(store.question(alice, id).request, questionRequest);
  assert.deepEqual(store.question(alice, id).response, response);
  store.answer(alice, id, { content: { size: 2, colour: 'blue' }, action: 'accept' });
  assert.throws(() => store.answer(alice, id, { action: 'cancel' }), { code: 'conflict' });
  assert.deepEqual(store.question(alice, id).response, response);
  const answers = store.events(alice).events.filter(event => event.topic === 'question.answered');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].object_id, id);
});

test('invalid mutation identity fails before creating state', async t => {
  const f = await fixture(t);
  const store = f.open();
  for (const key of ['', 'short', 'x'.repeat(201), null, 123]) {
    assert.throws(() => store.submit(alice, key, 'codex', request), { code: 'invalid_request_id' });
  }
  assert.deepEqual(store.list(alice), []);
  assert.deepEqual(store.events(alice), { events: [], nextCursor: 0 });
});
