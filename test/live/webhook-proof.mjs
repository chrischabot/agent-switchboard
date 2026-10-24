#!/usr/bin/env node
// Explicit live proof: an owned public callback receives real signed MCP
// Events. Only the recorded owned Maestro fixture is renamed to its test name.
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { connectOperator } from '../../bin/call.mjs';
import { toolValue } from '../../src/providers.mjs';

const runKey = process.argv[2];
if (!runKey || !/^[a-zA-Z0-9_-]{8,100}$/.test(runKey)) throw new Error('Supply an explicit stable live test run key.');
const fixtures = JSON.parse(await readFile(new URL('../../evidence/live/fixtures.json', import.meta.url), 'utf8'));
const fixture = fixtures.maestro;
if (fixture?.purpose !== 'Switchboard dedicated live E2E' || !/^[a-f0-9-]{36}$/.test(fixture.id))
  throw new Error('The exact owned Maestro fixture is required.');
const secretBytes = randomBytes(32), secret = `whsec_${secretBytes.toString('base64')}`;
const callbackBase = process.env.SWITCHBOARD_TEST_CALLBACK_BASE ? new URL(process.env.SWITCHBOARD_TEST_CALLBACK_BASE) : null;
if (!callbackBase || (callbackBase.protocol !== 'https:' || callbackBase.username || callbackBase.password || callbackBase.search || callbackBase.hash))
  throw new Error('Use an owned HTTPS callback base without credentials or query parameters.');
const callbackPath = `${callbackBase?.pathname.replace(/\/$/, '') ?? ''}/${randomBytes(24).toString('hex')}`;
const deliveries = [], invalid = [], signal = Promise.withResolvers();
let operationId, subscription, params, timer;
const rpc = await connectOperator();
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== callbackPath) { res.writeHead(404).end(); return; }
  try {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 262144) throw new Error('body_bound'); chunks.push(chunk); }
    const body = Buffer.concat(chunks), id = req.headers['webhook-id'], timestamp = req.headers['webhook-timestamp'];
    if (typeof id !== 'string' || !/^\d+$/.test(timestamp ?? '') || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
      throw new Error('identity_or_timestamp');
    const expected = createHmac('sha256', secretBytes).update(`${id}.${timestamp}.`).update(body).digest();
    const signed = String(req.headers['webhook-signature'] ?? '').split(' ').some(signature => {
      if (!signature.startsWith('v1,')) return false;
      const value = Buffer.from(signature.slice(3), 'base64');
      return value.length === expected.length && timingSafeEqual(value, expected);
    });
    if (!signed) throw new Error('signature');
    const value = JSON.parse(body.toString('utf8'));
    if (value.type === 'verification' && typeof value.challenge === 'string') {
      deliveries.push({ verification: true });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: value.challenge }));
      return;
    }
    if (value.eventId !== id || value.name !== 'operation.changed' || value.data?.provider !== 'maestro') throw new Error('event_contract');
    deliveries.push({ eventId: id, operationId: value.data.operationId, status: value.data.status, cursor: value.cursor });
    res.writeHead(204).end();
    if (operationId && deliveries.some(d => d.operationId === operationId && ['succeeded', 'failed', 'outcome_unknown'].includes(d.status))) signal.resolve();
  } catch (error) { invalid.push(error.message); res.writeHead(400).end(); }
});
try {
  await new Promise(resolve => server.listen(Number(process.env.SWITCHBOARD_TEST_CALLBACK_PORT ?? 0), '127.0.0.1', resolve));
  const publicUrl = callbackBase.origin;
  params = { name: 'operation.changed', arguments: { provider: 'maestro' },
    delivery: { mode: 'webhook', url: publicUrl + callbackPath, secret }, ttlMs: 300000 };
  subscription = await rpc('events/subscribe', params);
  const raw = await rpc('tools/call', { name: 'sessions', arguments: { provider: 'maestro', action: 'rename',
    input: { id: fixture.id, name: 'Switchboard live test fixture', requestId: `live-webhook:${runKey}` } } });
  const operation = toolValue(raw).operation;
  if (!operation?.id || raw.isError) throw new Error('The exact fixture operation was not accepted.');
  operationId = operation.id;
  if (deliveries.some(d => d.operationId === operationId && ['succeeded', 'failed', 'outcome_unknown'].includes(d.status))) signal.resolve();
  timer = setTimeout(() => signal.reject(new Error('Signed operation event delivery timed out.')), 45000);
  await signal.promise; clearTimeout(timer);
  const own = deliveries.filter(d => d.operationId === operationId);
  if (invalid.length || !own.some(d => d.status === 'succeeded')) throw new Error('The live proof received an invalid or unsuccessful event.');
  const report = { at: new Date().toISOString(), runKey, status: 'live_pass',
    scope: 'public HTTPS signed MCP event receipt; no claim of model wakeup',
    verifiedChallenge: deliveries.some(d => d.verification), statuses: own.map(d => d.status),
    uniqueEventIds: new Set(own.map(d => d.eventId)).size, invalidRequests: invalid.length };
  const file = new URL(`../../evidence/live/webhook-${runKey}.json`, import.meta.url);
  await writeFile(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(timer);
  if (subscription) await rpc('events/unsubscribe', params).catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
