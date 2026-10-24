#!/usr/bin/env node
// Native Fabric protocol acceptance. Only an exact owned manual project's brief
// is written, with its existing goal. No model turn or project work is started.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CreateTaskResultV2Schema, GetTaskResultV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
import { connectOperator } from '../../bin/call.mjs';
import { toolValue } from '../../src/providers.mjs';

const runKey = process.argv[2];
if (!/^[a-zA-Z0-9_-]{8,100}$/.test(runKey ?? '')) throw new Error('Supply a stable live test run key.');
const fixtures = JSON.parse(await readFile(process.argv[3] ?? new URL('../../evidence/live/fixtures.json', import.meta.url), 'utf8'));
const fixture = fixtures.fabric;
assert.equal(fixture?.purpose, 'Switchboard dedicated live E2E');
assert.ok(fixture.id && fixture.projectId, 'Exact owned session and project IDs are required.');
const config = JSON.parse(await readFile(process.env.SWITCHBOARD_CONFIG ?? path.join(os.homedir(), '.local/state/agent-switchboard/config.json'), 'utf8'));
const native = config.providers.fabric;
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'switchboard-fabric-protocol-proof', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } } };
let sequence = 0;
async function nativeRpc(method, params = {}) {
  let token;
  if (native.tokenFile) token = (await readFile(native.tokenFile, 'utf8')).trim();
  else {
    const credentials = JSON.parse(await readFile(native.codexCredential.file, 'utf8'));
    token = Object.values(credentials).find(value => value.server_name === native.codexCredential.serverName && value.server_url === native.url)?.access_token;
  }
  assert.ok(token, 'An exact-endpoint native credential is required.');
  const id = ++sequence;
  const response = await fetch(native.url, { method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
      ...(params.name ? { 'mcp-name': params.name } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }), signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, 200, 'Native protocol HTTP request failed.');
  const body = await response.json();
  assert.equal(body.id, id);
  assert.ok(!body.error, 'Native JSON-RPC request was rejected; inspect its recorded operation before retrying.');
  return body.result;
}
function value(raw) {
  let current = raw;
  for (let count = 0; count < 8; count++) {
    assert.ok(!current?.isError && !current?.error, 'Native tool result failed.');
    const next = toolValue(current);
    if (next !== current) current = next;
    else if (current?.kind === 'result') current = current.value;
    else return current;
  }
  throw new Error('Invalid native result envelope.');
}
const rpc = await connectOperator();
const project = value(await rpc('tools/call', { name: 'projects_query', arguments: {
  provider: 'fabric', action: 'read', input: { id: fixture.projectId } } }));
assert.equal(project.mode, 'manual', 'Only an owned manual project can be used.');
assert.equal(project.projectId, fixture.projectId);
assert.equal(typeof project.brief?.goal, 'string');
const discovery = await nativeRpc('server/discover');
assert.ok(discovery.capabilities.extensions?.['io.modelcontextprotocol/tasks']);
const passive = await nativeRpc('tools/call', { name: 'thread_status', arguments: { thread: fixture.id } });
assert.notEqual(passive.resultType, 'task', 'Passive reads must not create task receipts.');
assert.equal(value(passive).thread.id ?? value(passive).thread.threadId, fixture.id);
const page = value(await nativeRpc('tools/call', { name: 'thread_list', arguments: { limit: 5 } }));
assert.ok(Array.isArray(page.threads) && page.threads.length <= 5, 'Thread listing did not return a bounded native page.');
const watch = value(await nativeRpc('tools/call', { name: 'thread_events_wait', arguments: { thread: fixture.id, waitMs: 0, limit: 5 } }));
assert.equal(watch.threadId, fixture.id);
assert.ok(Array.isArray(watch.events) && Number.isSafeInteger(watch.nextAfterSequence));
const output = new URL(`../../evidence/live/fabric-protocol-${runKey}.json`, import.meta.url);
const report = { at: new Date().toISOString(), runKey, status: 'dispatch_not_started',
  passiveRead: 'immediate', nativeThreadList: 'live_pass', nativeEventWait: 'live_pass' };
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const task = CreateTaskResultV2Schema.parse(await nativeRpc('tools/call', { name: 'project_update_brief', arguments: {
  projectId: fixture.projectId, idempotencyKey: `switchboard-protocol:${runKey}`, brief: { goal: project.brief.goal } } }));
// Preserve the task identity before waiting. A timeout or failed receipt is never
// an instruction to dispatch the mutation again with a different identity.
Object.assign(report, { status: 'in_progress', taskId: task.taskId });
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
let complete;
for (let count = 0; count < 5; count++) {
  complete = GetTaskResultV2Schema.parse(await nativeRpc('tasks/get', { taskId: task.taskId }));
  if (complete.status !== 'working') break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(complete.status, 'completed', 'Task is unresolved; preserve its identity and inspect native state.');
const accepted = value(complete.result);
assert.ok(['accepted', 'applied', 'completed'].includes(accepted.state), 'The native project command did not accept the update.');
await nativeRpc('tasks/cancel', { taskId: task.taskId });
assert.equal((await nativeRpc('tasks/get', { taskId: task.taskId })).status, 'completed');
const resource = await nativeRpc('resources/read', { uri: `tutti://tasks/${task.taskId}` });
assert.equal(JSON.parse(resource.contents[0].text).taskId, task.taskId);
Object.assign(report, { status: 'live_pass', nativeTask: 'completed_provider_call', taskCancel: 'completed_outcome_preserved',
  taskResource: 'live_pass', scope: 'native MCP exchanges; no inference, human answer, model wakeup or completed agent job is claimed' });
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
