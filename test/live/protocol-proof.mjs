#!/usr/bin/env node
// Real MCP resource invalidation and Tasks against the hub and owned Maestro
// broker. The only effect renames the exact fixture to its existing test name.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CreateTaskResultV2Schema, GetTaskResultV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectOperator } from '../../bin/call.mjs';
import { toolValue } from '../../src/providers.mjs';

const runKey = process.argv[2];
if (!/^[a-zA-Z0-9_-]{8,100}$/.test(runKey ?? '')) throw new Error('Supply a stable live test run key.');
const config = JSON.parse(await readFile(process.env.SWITCHBOARD_CONFIG ?? path.join(os.homedir(), '.local/state/agent-switchboard/config.json'), 'utf8'));
const fixtures = JSON.parse(await readFile(new URL('../../evidence/live/fixtures.json', import.meta.url), 'utf8'));
if (fixtures.maestro?.purpose !== 'Switchboard dedicated live E2E') throw new Error('An exact owned Maestro fixture is required.');
const token = (await readFile(config.clients.operator.tokenFile, 'utf8')).trim();
const capabilities = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'switchboard-live-protocol-proof', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': capabilities };
const notifications = [], invalidated = Promise.withResolvers();
const observer = new Client({ name: 'switchboard-live-subscription-proof', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
observer.setNotificationHandler('notifications/resources/updated', notification => {
  if (notification.params.uri === 'switchboard://events') { notifications.push(notification.params.uri); invalidated.resolve(); }
});
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`), {
  fetch: (url, init = {}) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${token}` }, redirect: 'error' }),
});
const nativeConfig = config.providers.maestro;
const native = new StdioClientTransport({ command: nativeConfig.command, args: nativeConfig.args,
  env: { ...process.env, ...nativeConfig.env }, stderr: 'pipe' });
const pending = new Map();
native.onmessage = message => { if (pending.has(message.id)) {
  const entry = pending.get(message.id); clearTimeout(entry.timer); pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
} };
native.onerror = () => { for (const entry of pending.values()) entry.reject(new Error('Native task transport failed.')); };
const nativeRpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('Native task exchange timed out.')); }, 45000);
  pending.set(id, { resolve, reject, timer });
  native.send({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }).catch(reject);
});
async function settled(get, taskId) {
  for (let count = 0; count < 5; count++) {
    const task = GetTaskResultV2Schema.parse(await get(taskId));
    if (task.status !== 'working') return task;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Task did not settle within five observations; preserve its identity.');
}
let subscription, deadline;
try {
  await observer.connect(transport);
  subscription = await observer.listen({ resourceSubscriptions: ['switchboard://events'] });
  const rpc = await connectOperator();
  const task = CreateTaskResultV2Schema.parse(await rpc('tools/call', { name: 'sessions', arguments: { provider: 'maestro', action: 'rename',
    input: { id: fixtures.maestro.id, name: 'Switchboard live test fixture', requestId: `live-protocol:${runKey}` } }, _meta: meta }));
  const complete = await settled(taskId => rpc('tasks/get', { taskId, _meta: meta }), task.taskId);
  if (complete.status !== 'completed' || toolValue(complete.result)?.completionScope !== 'provider_tool_call') throw new Error('Hub task did not preserve provider-call completion scope.');
  await rpc('tasks/cancel', { taskId: task.taskId, _meta: meta });
  if ((await rpc('tasks/get', { taskId: task.taskId, _meta: meta })).status !== 'completed') throw new Error('Cancelling a completed task changed its outcome.');
  deadline = setTimeout(() => invalidated.reject(new Error('Real resource invalidation was not received.')), 10000);
  await invalidated.promise; clearTimeout(deadline);
  await native.start();
  await nativeRpc('tools/list');
  const argumentsBase = { action: 'changes', targets: [{ connectionId: 'maestro', kind: 'session', id: fixtures.maestro.id }],
    projection: 'metadata', events: ['question'], page: { limit: 10 } };
  const baseline = CreateTaskResultV2Schema.parse(await nativeRpc('tools/call', { name: 'maestro_watch', arguments: { ...argumentsBase, waitMs: 0 } }));
  const baselineResult = await settled(taskId => nativeRpc('tasks/get', { taskId }), baseline.taskId);
  const cursor = toolValue(baselineResult.result)?.data?.cursor;
  if (baselineResult.status !== 'completed' || typeof cursor !== 'string') throw new Error('Native task did not return a bounded watch cursor.');
  const longRead = CreateTaskResultV2Schema.parse(await nativeRpc('tools/call', { name: 'maestro_watch', arguments: { ...argumentsBase, cursor, waitMs: 3000 } }));
  if ((await nativeRpc('tasks/get', { taskId: longRead.taskId })).status !== 'working') throw new Error('Native read task was not running at cancellation.');
  await nativeRpc('tasks/cancel', { taskId: longRead.taskId });
  const afterCancel = GetTaskResultV2Schema.parse(await nativeRpc('tasks/get', { taskId: longRead.taskId }));
  if (afterCancel.status !== 'working') throw new Error('Native receipt cancellation fabricated an interruption of its running read.');
  // This provider acknowledges best-effort cancellation without claiming that
  // its native request stopped. Verify the read's eventual result separately.
  await new Promise(resolve => setTimeout(resolve, 3500));
  const finalRead = GetTaskResultV2Schema.parse(await nativeRpc('tasks/get', { taskId: longRead.taskId }));
  if (finalRead.status !== 'completed') throw new Error('The native read did not retain its actual completion after cancellation acknowledgment.');
  const report = { at: new Date().toISOString(), status: 'live_pass', runKey,
    hubTask: 'completed_provider_call', completedTaskCancel: 'outcome_preserved',
    resourceInvalidation: notifications.length > 0, nativeMaestroTask: baselineResult.status,
    nativeMaestroReadCancellation: 'acknowledged_without_fabricating_native_interruption', nativeReadFinalState: finalRead.status,
    scope: 'real protocol exchanges; cancelling an observation task does not claim an agent job stopped' };
  await writeFile(new URL(`../../evidence/live/protocol-${runKey}.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(deadline);
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Live proof closed.')); }
  pending.clear();
  await subscription?.close(); await observer.close(); await native.close();
}
