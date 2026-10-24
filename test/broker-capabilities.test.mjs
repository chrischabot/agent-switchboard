import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { Broker, normalizedInputSchema } from '../src/broker.mjs';
import { McpProvider } from '../src/providers.mjs';
import { Store } from '../src/store.mjs';

const string = { type: 'string', minLength: 1 };
const target = { type: 'object', properties: { connectionId: { const: 'maestro' },
  kind: { enum: ['session', 'project'] }, id: string }, required: ['connectionId', 'kind', 'id'], additionalProperties: false };
const tool = (name, properties, required, readOnlyHint) => ({ name, annotations: { readOnlyHint },
  inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const ajv = new Ajv2020({ strict: false });

function fixture(t, id, catalog) {
  const calls = [], store = new Store(':memory:');
  const provider = new McpProvider(id, {});
  provider.catalog = catalog;
  provider.validators = new Map(catalog.map(t => [t.name, ajv.compile(t.inputSchema)]));
  provider.descriptor = { id, support: 'native', availability: 'ready' };
  provider.call = async (name, args) => { calls.push({ name, args }); return { status: 'accepted' }; };
  const broker = new Broker(store, new Map([[id, provider]]), { clients: { caller: { providers: [id] } } });
  t.after(async () => { await broker.close(); store.close(); });
  return { broker, calls, store };
}

// A caller can discover normalized arguments and a passive status read even
// when the native tool also offers a mutating action (Maestro inspect/hydrate).
test('Maestro capabilities describe the executable passive status contract and exact input.id field', async t => {
  const f = fixture(t, 'maestro', [tool('maestro_inspect', {
    action: { const: 'get' }, target, view: { const: 'summary' },
  }, ['action', 'target'], false)]);
  for (const [operation, kind] of [['sessions.status', 'session'], ['projects.read', 'project']]) {
    const capability = f.broker.capabilities('caller', 'maestro').operations.find(c => c.operation === operation);
    assert.equal(capability.support, 'native');
    assert.equal(capability.nativeTool, 'maestro_inspect');
    assert.equal(capability.readOnly, true);
    assert.deepEqual(capability.inputSchema.required, ['id']);
    const validate = ajv.compile(capability.inputSchema);
    assert.equal(validate({ sessionId: 'fixture-target' }), false);
    assert.equal(validate({ id: 'fixture-target' }), true);
    const response = await f.broker.operate('caller', 'maestro', operation, { id: 'fixture-target' });
    assert.equal(response.kind, 'result');
    assert.deepEqual(f.calls.at(-1), { name: 'maestro_inspect', args: {
      action: 'get', target: { connectionId: 'maestro', kind, id: 'fixture-target' }, view: 'summary',
    } });
  }
  assert.equal(f.store.list('caller').length, 0, 'advertised reads produce no mutation receipt or requestId requirement');
  assert.equal(f.broker.capabilities('caller', 'maestro').nativeTools[0].readOnly, false,
    'native mixed-action tool remains conservatively classified');
});

test('Fabric stop discovery requires the exact turn guard and refusal precedes dispatch', async t => {
  const f = fixture(t, 'fabric', [tool('thread_cancel', {
    thread: string, turnId: string, confirm: { const: true },
  }, ['thread', 'confirm'], false)]);
  const capability = f.broker.capabilities('caller', 'fabric').operations.find(c => c.operation === 'sessions.stop');
  assert.equal(capability.readOnly, false);
  assert.deepEqual(new Set(capability.inputSchema.required), new Set(['id', 'requestId', 'expectedTurnId']));
  const input = { id: 'thr_fixture', requestId: 'fixture-stop-1' };
  assert.equal(ajv.compile(capability.inputSchema)(input), false);
  await assert.rejects(f.broker.operate('caller', 'fabric', 'sessions.stop', input), { code: 'invalid_arguments' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.list('caller').length, 0);
  await f.broker.operate('caller', 'fabric', 'sessions.stop', { ...input, expectedTurnId: 'turn_fixture' });
  await Promise.all([...f.broker.running.values()]);
  assert.deepEqual(f.calls, [{ name: 'thread_cancel', args: { thread: 'thr_fixture', turnId: 'turn_fixture', confirm: true } }]);
});

test('Fabric search never silently discards pagination that its native resolver cannot consume', async t => {
  const f = fixture(t, 'fabric', [tool('fabric_resolve', { query: string, kind: { const: 'thread' } }, ['query'], true)]);
  const capability = f.broker.capabilities('caller', 'fabric').operations.find(c => c.operation === 'sessions.search');
  assert.equal(capability.readOnly, true);
  assert.deepEqual(Object.keys(capability.inputSchema.properties), ['query']);
  assert.equal(capability.semantics, 'bounded_name_resolution_without_pagination');
  await assert.rejects(f.broker.operate('caller', 'fabric', 'sessions.search', { query: 'fixture', limit: 5 }), { code: 'unsupported_argument' });
  await assert.rejects(f.broker.operate('caller', 'fabric', 'sessions.search', { query: 'fixture', cursor: 'must-not-drop' }), { code: 'unsupported_argument' });
  assert.equal(f.calls.length, 0);
  await f.broker.operate('caller', 'fabric', 'sessions.search', { query: 'fixture' });
  assert.deepEqual(f.calls, [{ name: 'fabric_resolve', args: { query: 'fixture', kind: 'thread' } }]);
});

test('generic discovery retains provider-specific limits and schemas enforce mutation prerequisites', () => {
  const generic = ajv.compile(normalizedInputSchema());
  assert.equal(generic({ id: 'thr_fixture', limit: 2000 }), true);
  assert.equal(ajv.compile(normalizedInputSchema('fabric', 'sessions.read'))({ id: 'thr_fixture', limit: 2000 }), true);
  assert.equal(ajv.compile(normalizedInputSchema('maestro', 'sessions.read'))({ id: 'fixture', limit: 201 }), false);
  const examples = [
    ['fabric', 'sessions.resume', { id: 'thr_fixture', requestId: 'fixture-resume', text: 'New prompt' }, 'text'],
    ['fabric', 'projects.update', { id: 'prj_fixture', requestId: 'fixture-update', brief: { goal: 'Fixture' } }, 'brief'],
    ['fabric', 'projects.delete', { id: 'prj_fixture', requestId: 'fixture-delete', confirmationToken: 'native-project-preview' }, 'confirmationToken'],
    ['maestro', 'sessions.rename', { id: 'fixture', requestId: 'fixture-rename', name: 'New name' }, 'name'],
    ['maestro', 'sessions.delete', { id: 'fixture', requestId: 'fixture-delete', confirmationToken: 'native-preview' }, 'confirmationToken'],
  ];
  for (const [provider, operation, input, required] of examples) {
    const schema = normalizedInputSchema(provider, operation), validate = ajv.compile(schema);
    assert.equal(validate(input), true, `${provider} ${operation}`);
    assert.equal(generic(input), true, `${provider} ${operation} is accepted by generic discovery`);
    const missing = { ...input }; delete missing[required];
    assert.equal(validate(missing), false, `${provider} ${operation} requires ${required}`);
  }
});

test('Fabric coordinated projects use native lifecycle previews and token-guarded deletion', async t => {
  const f = fixture(t, 'fabric', [
    tool('project_lifecycle_preview', { projectId: string }, ['projectId'], true),
    tool('project_lifecycle', { projectId: string, action: { enum: ['archive', 'restore', 'delete'] },
      idempotencyKey: string, confirmationToken: string }, ['projectId', 'action', 'idempotencyKey'], false),
    tool('project_delete', { project: string, expectedName: string, confirm: { const: true } }, ['project', 'expectedName', 'confirm'], false),
  ]);
  const input = { id: 'owned-project-fixture' };
  const preview = await f.broker.operate('caller', 'fabric', 'projects.delete_preview', input);
  assert.equal(preview.kind, 'result');
  assert.equal(f.store.list('caller').length, 0);
  await assert.rejects(f.broker.operate('caller', 'fabric', 'projects.delete', { ...input, requestId: 'missing-preview-token' }), { code: 'invalid_arguments' });
  assert.equal(f.calls.length, 1, 'A missing token cannot reach any native delete operation');
  for (const action of ['archive', 'restore', 'delete']) {
    const requestId = `project-lifecycle-${action}`;
    const result = await f.broker.operate('caller', 'fabric', `projects.${action}`, { ...input, requestId,
      ...(action === 'delete' ? { confirmationToken: 'exact-native-preview' } : {}) });
    await Promise.all(f.broker.running.values());
    assert.equal(f.store.get('caller', result.operation.id).status, 'succeeded');
    assert.deepEqual(f.calls.at(-1), { name: 'project_lifecycle', args: { projectId: input.id, action, idempotencyKey: requestId,
      ...(action === 'delete' ? { confirmationToken: 'exact-native-preview' } : {}) } });
  }
  assert.equal(f.calls.some(call => call.name === 'project_delete'), false, 'Legacy resource deletion cannot delete coordinated projects');
});
