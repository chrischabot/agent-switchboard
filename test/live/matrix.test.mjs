import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runMatrix, validateMutation, persistReport, PROVIDERS, OPERATIONS } from './matrix.mjs';

const fixtures = Object.fromEntries(PROVIDERS.map(provider => [provider,
  { id: `${provider}-owned-fixture`, purpose: 'Switchboard dedicated live E2E' }]));
const wrap = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

function boundary({ failRoute, logicalFailure, mutationStatus = 'dispatching', unavailable, reply } = {}) {
  const calls = [];
  const descriptors = PROVIDERS.map(id => ({ id, kind: 'mcp', support: 'native', availability: unavailable === id ? 'offline' : 'ready',
    serverInfo: { name: `${id}-fixture`, version: '1.2.3' }, observedAt: '2026-10-24T00:00:00Z',
    capabilities: { tools: {}, resources: {}, prompts: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } } }));
  const connect = async caller => async (method, params = {}) => {
    calls.push({ caller, method, params: structuredClone(params) });
    const override = reply?.(caller, method, params);
    if (override !== undefined) return override;
    if (method === 'server/discover') return { supportedVersions: ['2026-07-28'], capabilities: { events: {} } };
    if (method === 'tools/list') return { tools: [] };
    if (method === 'prompts/list') return { prompts: [] };
    if (method === 'resources/list') return { resources: [] };
    if (method === 'events/list') return { events: [] };
    if (method === 'resources/read' || method === 'prompts/get') return { content: [{ type: 'text', text: 'private content fixture' }] };
    assert.equal(method, 'tools/call');
    const { name, arguments: args } = params;
    if (failRoute?.caller === caller && failRoute?.target === args.provider) return { isError: true, ...wrap({ code: 'forbidden', message: 'Bearer private-secret-never-print' }) };
    if (name === 'agents_list') return wrap({ agents: descriptors });
    if (name === 'capabilities_get') return wrap({ provider: descriptors.find(x => x.id === args.provider),
      operations: OPERATIONS.map(operation => ({ operation, support: operation === 'sessions.create' || unavailable === args.provider ? 'unsupported' : 'native',
        availability: unavailable === args.provider ? 'offline' : 'ready', nativeTool: `native_${operation.replace('.', '_')}` })),
      nativeTools: [{ name: 'fixture_native_read', readOnly: true }, { name: 'fixture_native_write', readOnly: false }],
    });
    if (name === 'provider_prompts') return wrap({ prompts: [{ name: 'safe-template' }] });
    if (name === 'provider_resources') return wrap({ resources: [{ uri: 'private://do-not-record' }] });
    if (name === 'operations_get') return wrap({ id: args.operationId, status: mutationStatus });
    if (['sessions', 'projects'].includes(name)) {
      if (logicalFailure === args.provider && args.action === 'status') return wrap({ kind: 'result', value: wrap({ status: 'rejected', error: { code: 'stale_target', message: 'private transcript fixture' } }) });
      if (args.action === 'list') return wrap({ kind: 'result', value: { sessions: [{ id: 'unrelated-never-select' }], access_token: 'must-not-persist' } });
      if (['status', 'read', 'search'].includes(args.action)) return wrap({ kind: 'result', value: { status: 'ok', text: 'private transcript fixture Bearer private-secret-never-print' } });
      return wrap({ kind: 'operation', operation: { id: 'fixture-operation-receipt', status: mutationStatus } });
    }
    throw new Error('Unexpected fixture request');
  };
  return { connect, calls };
}

test('default matrix covers every declared operation and sixteen routes without originating-agent claims or writes', async () => {
  const b = boundary();
  const report = await runMatrix({ connect: b.connect, fixtures });
  assert.equal(report.mode, 'read_only');
  assert.equal(report.routes.length, 16);
  for (const provider of PROVIDERS) {
    assert.deepEqual(Object.keys(report.providers[provider].operations), OPERATIONS);
    assert.equal(report.providers[provider].nativeTools.length, 2);
    assert.equal(report.providers[provider].operations['sessions.create'].status, 'unsupported');
    assert.equal(report.providers[provider].operations['sessions.message'].status, 'not_run');
    assert.equal(report.providers[provider].operations['sessions.status'].status, 'live_pass');
    assert.equal(report.providers[provider].features['mcp.tasks.create'].status, 'not_run');
  }
  assert.ok(report.routes.every(route => route.harness.status === 'live_pass' && route.originatingAgent.status === 'not_run'));
  assert.ok(report.routes.every(route => route.harness.code === undefined));
  for (const { method, params } of b.calls) {
    assert.notEqual(method, 'tasks/update');
    assert.notEqual(method, 'tasks/cancel');
    assert.notEqual(method, 'events/subscribe');
    if (method === 'tools/call' && ['sessions', 'projects'].includes(params.name))
      assert.ok(['list', 'read', 'status', 'search'].includes(params.arguments.action));
  }
});

test('read/status never select unrelated list results and missing fixtures stay blocked', async () => {
  const b = boundary();
  const report = await runMatrix({ connect: b.connect, fixtures: { codex: fixtures.codex } });
  for (const provider of ['claude', 'fabric', 'maestro']) {
    assert.equal(report.providers[provider].operations['sessions.read'].status, 'blocked');
    assert.equal(report.providers[provider].operations['sessions.status'].status, 'blocked');
  }
  const targeted = b.calls.filter(call => call.method === 'tools/call' && ['read', 'status'].includes(call.params.arguments?.action));
  assert.ok(targeted.length > 0);
  assert.ok(targeted.every(call => call.params.arguments.input.id === fixtures.codex.id));
  assert.ok(!b.calls.some(call => JSON.stringify(call.params).includes('unrelated-never-select')));
});

test('mutation plan fails closed before connecting on opt-in, ownership, target, model-start and extra-argument violations', async () => {
  const entry = { provider: 'codex', operation: 'sessions.rename', input: { id: fixtures.codex.id, name: 'Fixture name' } };
  const opts = { allowMutations: true, runKey: 'repeatable-fixture-run' };
  assert.throws(() => validateMutation(entry, fixtures, { runKey: opts.runKey }), /allow-mutations/);
  assert.throws(() => validateMutation(entry, fixtures, { allowMutations: true }), /run-key/);
  assert.throws(() => validateMutation(entry, { codex: { id: fixtures.codex.id } }, opts), /ownership/);
  assert.throws(() => validateMutation({ ...entry, input: { ...entry.input, id: 'unrelated' } }, fixtures, opts), /exact recorded/);
  for (const operation of ['sessions.create', 'sessions.message', 'sessions.steer', 'sessions.resume', 'projects.update'])
    assert.throws(() => validateMutation({ ...entry, operation }, fixtures, opts), /model-starting/);
  assert.throws(() => validateMutation({ ...entry, input: { ...entry.input, target: { id: 'unrelated' } } }, fixtures, opts), /Unknown mutation/);
  assert.throws(() => validateMutation({ ...entry, operation: 'sessions.stop', input: { id: fixtures.codex.id } }, fixtures, opts), /turn ID/);
  let connections = 0;
  await assert.rejects(runMatrix({ connect: async () => { connections++; }, fixtures, mutations: [entry] }), /allow-mutations/);
  assert.equal(connections, 0);
  assert.equal(validateMutation(entry, fixtures, opts).input.requestId,
    validateMutation({ ...entry, input: { name: 'Changed name', id: fixtures.codex.id } }, fixtures, opts).input.requestId,
    'a changed payload retains the logical request identity so the broker can reject conflicts');
});

test('opt-in fixture mutation is sent once, uses a stable requestId and does not claim pending receipt completion', async () => {
  const b = boundary();
  const options = { connect: b.connect, fixtures, allowMutations: true, runKey: 'stable-acceptance-run', routes: false,
    mutations: [{ provider: 'codex', operation: 'sessions.rename', input: { id: fixtures.codex.id, name: 'Fixture revised' } }] };
  const first = await runMatrix(options);
  const second = await runMatrix(options);
  const writes = b.calls.filter(call => call.params.arguments?.action === 'rename');
  assert.equal(writes.length, 2, 'exactly one dispatch per explicit run, no in-run retry');
  assert.equal(writes[0].params.arguments.input.requestId, writes[1].params.arguments.input.requestId);
  assert.equal(first.providers.codex.operations['sessions.rename'].status, 'blocked');
  assert.equal(second.providers.codex.operations['sessions.rename'].operationId, 'fixture-operation-receipt');
  assert.equal(b.calls.filter(call => call.params.name === 'operations_get').length, 2, 'one receipt read per explicit run');
});

test('route denial and nested provider rejection remain failures and unavailable discovery is not unsupported', async () => {
  const b = boundary({ failRoute: { caller: 'claude', target: 'fabric' }, logicalFailure: 'maestro', unavailable: 'fabric' });
  const report = await runMatrix({ connect: b.connect, fixtures });
  assert.equal(report.routes.find(route => route.caller === 'claude' && route.target === 'fabric').harness.status, 'live_fail');
  assert.equal(report.providers.maestro.operations['sessions.status'].status, 'live_fail');
  assert.equal(report.providers.fabric.operations['sessions.create'].status, 'blocked');
  assert.equal(report.providers.fabric.operations['sessions.create'].code, 'provider_unavailable_capability_unknown');
  assert.equal(report.routes.find(route => route.caller === 'codex' && route.target === 'fabric').harness.status, 'blocked');
  assert.ok(report.routes.every(route => route.originatingAgent.status === 'not_run'));
});

test('nested Fabric MCP failures stay failures through complete result and text envelopes', async () => {
  const nativeError = { code: 'UPSTREAM_ERROR', message: 'private native failure details' };
  const cases = [
    { name: 'native isError plus structured error', value: { ...wrap({ error: nativeError }), isError: true } },
    { name: 'structured error without isError', value: wrap({ error: nativeError }) },
    { name: 'native isError and diagnostic text only', value: { isError: true, content: [{ type: 'text', text: 'private native failure details' }] } },
    { name: 'text-encoded native error envelope', value: { content: [{ type: 'text', text: JSON.stringify({ error: nativeError }) }] } },
    { name: 'additional complete wrapper', value: wrap({ kind: 'result', value: { ...wrap({ error: nativeError }), isError: true } }) },
  ];
  for (const sample of cases) {
    const b = boundary({ reply: (_caller, method, params) => method === 'tools/call' && params.name === 'projects'
      && params.arguments.provider === 'fabric' && params.arguments.action === 'read'
      ? { resultType: 'complete', ...wrap({ kind: 'result', value: sample.value }) } : undefined });
    const report = await runMatrix({ connect: b.connect, routes: false,
      fixtures: { ...fixtures, fabric: { ...fixtures.fabric, projectId: 'fabric-owned-project-fixture' } } });
    const cell = report.providers.fabric.operations['projects.read'];
    assert.equal(cell.status, 'live_fail', sample.name);
    assert.ok(report.summary.live_fail > 0, sample.name);
    assert.equal(JSON.stringify(report).includes('private native failure details'), false);
    if (sample.name !== 'native isError and diagnostic text only') assert.equal(cell.code, 'upstream_error', sample.name);
  }
});

test('operation receipt success cannot conceal nested native or nested receipt failures', async () => {
  const error = { ...wrap({ error: { code: 'UPSTREAM_ERROR', message: 'private receipt rejection' } }), isError: true };
  for (const sample of [
    { name: 'polled native failure', initial: 'dispatching', polled: { id: 'fixture-operation-receipt', status: 'succeeded', result: error }, expected: 'live_fail' },
    { name: 'polled nested receipt failure', initial: 'dispatching', polled: { id: 'fixture-operation-receipt', status: 'succeeded', result: wrap({ kind: 'operation', operation: { status: 'succeeded', result: error } }) }, expected: 'live_fail' },
    { name: 'initial rejection survives clean later receipt', initial: 'succeeded', initialResult: error, polled: { id: 'fixture-operation-receipt', status: 'succeeded' }, expected: 'live_fail' },
    { name: 'polled unknown outcome', initial: 'dispatching', polled: { id: 'fixture-operation-receipt', status: 'outcome_unknown' }, expected: 'blocked' },
    { name: 'polled nested unavailable', initial: 'dispatching', polled: { id: 'fixture-operation-receipt', status: 'succeeded', result: wrap({ status: 'unavailable', error: { code: 'OFFLINE' } }) }, expected: 'blocked' },
    { name: 'polled success is receipt only', initial: 'dispatching', polled: { id: 'fixture-operation-receipt', status: 'succeeded', result: wrap({ status: 'ok' }) }, expected: 'live_pass' },
  ]) {
    const b = boundary({ reply: (_caller, method, params) => {
      if (method !== 'tools/call') return;
      if (params.name === 'operations_get') return wrap(sample.polled);
      if (params.name === 'sessions' && params.arguments.action === 'rename') return wrap({ kind: 'operation', operation: {
        id: 'fixture-operation-receipt', status: sample.initial, ...(sample.initialResult ? { result: sample.initialResult } : {}),
      } });
    } });
    const report = await runMatrix({ connect: b.connect, fixtures, routes: false, allowMutations: true, runKey: 'receipt-rejection',
      mutations: [{ provider: 'codex', operation: 'sessions.rename', input: { id: fixtures.codex.id, name: 'Receipt fixture' } }] });
    const cell = report.providers.codex.operations['sessions.rename'];
    assert.equal(cell.status, sample.expected, sample.name);
    if (sample.expected === 'live_fail') assert.equal(cell.code, 'upstream_error', sample.name);
    if (sample.expected === 'live_pass') assert.equal(cell.code, 'provider_call_receipt_only', sample.name);
    assert.equal(b.calls.filter(call => call.params.name === 'operations_get').length, 1, sample.name);
    assert.equal(JSON.stringify(report).includes('private receipt rejection'), false);
  }
});

test('only result envelopes are inspected; ordinary domain error records are not classified as tool failures', async () => {
  const b = boundary({ reply: (_caller, method, params) => method === 'tools/call' && params.name === 'sessions'
    && params.arguments.action === 'read' ? wrap({ kind: 'result', value: wrap({ status: 'ok',
      data: { error: { code: 'HISTORICAL_ERROR' } }, messages: [{ isError: true, error: { code: 'PAST_FAILURE' } }],
    }) }) : undefined });
  const report = await runMatrix({ connect: b.connect, fixtures, routes: false });
  for (const provider of PROVIDERS) assert.equal(report.providers[provider].operations['sessions.read'].status, 'live_pass');
  assert.equal(report.summary.live_fail, 0);
});

test('outer protocol errors and malformed or excessively deep result envelopes cannot pass', async () => {
  let excessive = wrap({ status: 'ok' });
  for (let index = 0; index < 40; index++) excessive = { structuredContent: { kind: 'result', value: excessive } };
  for (const sample of [
    { error: { code: -32602, message: 'private protocol error' } },
    { isError: true, ...wrap({ status: 'ok' }) },
    wrap({ kind: 'result' }),
    wrap({ kind: 'operation' }),
    excessive,
  ]) {
    const b = boundary({ reply: (_caller, method) => method === 'tools/list' ? sample : undefined });
    const report = await runMatrix({ connect: b.connect, fixtures, routes: false });
    assert.equal(report.protocol['tools/list'].status, 'live_fail');
    assert.ok(report.summary.live_fail > 0);
    assert.equal(JSON.stringify(report).includes('private protocol error'), false);
  }
});

test('persisted bounded evidence excludes response bodies, secrets, raw errors and transcript contents', async t => {
  const b = boundary({ failRoute: { caller: 'claude', target: 'fabric' } });
  const report = await runMatrix({ connect: b.connect, fixtures });
  const text = JSON.stringify(report);
  for (const forbidden of ['private transcript fixture', 'private-secret-never-print', 'must-not-persist', 'private://do-not-record', 'private content fixture'])
    assert.equal(text.includes(forbidden), false, forbidden);
  assert.ok(report.evidence.every(evidence => evidence.at && evidence.requestSha256 && !('body' in evidence)));
  const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-live-matrix-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'matrix.json');
  await persistReport(report, output);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).schema, 'switchboard.live-matrix.v1');
  await assert.rejects(persistReport(report, output), { code: 'EEXIST' });
  await assert.rejects(persistReport({ large: 'x'.repeat(2 * 1024 * 1024) }, path.join(directory, 'oversized.json')), /2 MiB/);
});
