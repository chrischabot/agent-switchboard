#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectOperator } from '../../bin/call.mjs';
import { toolValue } from '../../src/providers.mjs';

export const PROVIDERS = ['codex', 'claude', 'fabric', 'maestro'];
export const STATUSES = ['live_pass', 'live_fail', 'unsupported', 'blocked', 'not_run'];
export const OPERATIONS = ['sessions.list', 'sessions.search', 'sessions.read', 'sessions.status',
  'sessions.create', 'sessions.message', 'sessions.steer', 'sessions.stop', 'sessions.resume',
  'sessions.rename', 'sessions.archive', 'sessions.restore', 'sessions.delete_preview', 'sessions.delete',
  'projects.list', 'projects.read', 'projects.create', 'projects.update', 'projects.archive', 'projects.restore', 'projects.delete'];
const MUTATION_KEYS = {
  'sessions.rename': ['id', 'name'], 'sessions.stop': ['id', 'expectedTurnId'],
  'sessions.archive': ['id'], 'sessions.restore': ['id'],
  'sessions.delete_preview': ['id'], 'sessions.delete': ['id', 'confirmationToken'],
};
const protocolVersion = '2026-07-28';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const safeCode = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(value) ? value.toLowerCase() : 'operation_failed';
const utc = () => new Date().toISOString();

export function fixtureId(fixtures, provider, family = 'sessions') {
  const value = family === 'projects' ? fixtures[provider]?.projectId : fixtures[provider]?.id;
  return identifier(value) ? value : undefined;
}

export function validateMutation(entry, fixtures, { allowMutations = false, runKey } = {}) {
  if (!allowMutations) throw new Error('Mutation execution requires --allow-mutations.');
  if (!identifier(runKey)) throw new Error('Mutations require a stable --run-key.');
  if (!object(entry) || Object.keys(entry).some(key => !['provider', 'operation', 'input'].includes(key))) throw new Error('Invalid mutation plan entry.');
  if (!PROVIDERS.includes(entry.provider) || !MUTATION_KEYS[entry.operation])
    throw new Error('This operation is not an allowed fixture-only mutation; model-starting operations require manual acceptance.');
  const expectedId = fixtureId(fixtures, entry.provider);
  if (fixtures[entry.provider]?.purpose !== 'Switchboard dedicated live E2E') throw new Error('Mutation fixture must carry the dedicated live E2E ownership marker.');
  if (!expectedId || entry.input?.id !== expectedId) throw new Error('Mutation target must equal the exact recorded session fixture ID.');
  if (!object(entry.input) || Object.keys(entry.input).some(key => !MUTATION_KEYS[entry.operation].includes(key)))
    throw new Error('Unknown mutation argument; arbitrary nested targets and request IDs are forbidden.');
  if (entry.operation === 'sessions.rename' && (typeof entry.input.name !== 'string' || !entry.input.name || entry.input.name.length > 200))
    throw new Error('Rename requires a bounded name.');
  if (entry.operation === 'sessions.stop' && ['codex', 'fabric'].includes(entry.provider) && !identifier(entry.input.expectedTurnId))
    throw new Error('Stop requires the current exact fixture turn ID.');
  if (entry.operation === 'sessions.delete' && (typeof entry.input.confirmationToken !== 'string' || !entry.input.confirmationToken || entry.input.confirmationToken.length > 2000))
    throw new Error('Delete requires the reviewed native fixture deletion confirmation.');
  return { ...entry, input: { ...entry.input,
    requestId: `live-matrix:${sha([runKey, entry.provider, entry.operation, expectedId]).slice(0,48)}` } };
}

function nativeValue(raw) {
  let value = toolValue(raw);
  if (value?.kind === 'result') value = toolValue(value.value);
  return value;
}

// Evidence contains no raw response strings, prompts, paths, URIs, credentials or
// transcripts. A hash binds the bounded metadata to the exact in-memory result.
export function evidenceSummary(raw) {
  const value = nativeValue(raw);
  const summary = { sha256: sha(raw), bytes: Buffer.byteLength(JSON.stringify(raw) ?? '') };
  for (const key of ['agents', 'tools', 'prompts', 'resources', 'sessions', 'projects', 'items', 'messages', 'events'])
    if (Array.isArray(value?.[key])) summary[`${key}Count`] = value[key].length;
  if (['ready', 'running', 'working', 'waiting', 'idle', 'completed', 'succeeded', 'failed', 'rejected', 'accepted', 'ok', 'offline', 'cancelled', 'outcome_unknown', 'unavailable'].includes(value?.status))
    summary.nativeStatus = value.status;
  return summary;
}

function outcome(raw, { receipt = false } = {}) {
  // Inspect every known protocol envelope before toolValue removes it. In
  // particular, a successful dispatch receipt does not erase native isError.
  // Do not descend into arbitrary domain data (such as logged error records).
  const layers = [], receipts = [], seen = new Set();
  let value = raw;
  for (let depth = 0; object(value); depth++) {
    if (depth >= 32 || seen.has(value)) return { status: 'live_fail', code: 'invalid_result_envelope' };
    seen.add(value);
    layers.push(value);
    const unwrapped = toolValue(value);
    if (unwrapped !== value) { value = unwrapped; continue; }
    if (value.kind === 'result') {
      if (!object(value.value)) return { status: 'live_fail', code: 'invalid_result_envelope' };
      value = value.value; continue;
    }
    if (value.kind === 'operation') {
      if (!object(value.operation)) return { status: 'live_fail', code: 'invalid_result_envelope' };
      receipt = true; value = value.operation; continue;
    }
    if (receipt) {
      receipts.push(value);
      receipt = false;
      value = value.result;
      continue;
    }
    break;
  }
  const failures = layers.filter(layer => layer.isError === true || layer.error != null && layer.error !== false
    || ['rejected', 'conflict', 'failed', 'unavailable', 'outcome_unknown', 'offline', 'auth_required', 'disconnected', 'unsupported', 'unsupported_capability'].includes(layer.status));
  if (failures.length) {
    const detail = [...layers].reverse().find(layer => layer.error?.code != null || layer.code != null)
      ?? failures.at(-1);
    const code = safeCode(detail.error?.code ?? detail.code ?? detail.status);
    return { status: ['unsupported', 'unsupported_capability'].includes(code) ? 'unsupported'
      : /auth|unavailable|offline|outcome_unknown|disconnected/.test(code) ? 'blocked' : 'live_fail', code };
  }
  if (receipts.length) {
    const succeeded = receipts.every(operation => operation.status === 'succeeded');
    return { status: succeeded ? 'live_pass' : 'blocked', code: succeeded ? 'provider_call_receipt_only' : 'receipt_not_settled' };
  }
  if (!object(raw)) return { status: 'live_fail', code: 'invalid_result_envelope' };
  return { status: 'live_pass' };
}

function featureDeclarations(descriptor) {
  const caps = descriptor?.capabilities ?? {};
  const hasTasks = object(caps.extensions?.['io.modelcontextprotocol/tasks']);
  return {
    'mcp.discovery': descriptor?.kind === 'mcp',
    'mcp.prompts.list': object(caps.prompts), 'mcp.prompts.get': object(caps.prompts),
    'mcp.resources.list': object(caps.resources), 'mcp.resources.read': object(caps.resources),
    'mcp.subscriptions': caps.resources?.subscribe === true || caps.tools?.listChanged === true,
    'mcp.tasks.create': hasTasks, 'mcp.tasks.get': hasTasks, 'mcp.tasks.update': hasTasks, 'mcp.tasks.cancel': hasTasks,
    // Elicitation is client capability, not a server capability declaration.
    'mcp.elicitation.form': null, 'mcp.elicitation.url': null,
    'mcp.events.list': object(caps.events), 'mcp.events.delivery': object(caps.events),
  };
}

function readInput(provider, operation, fixtures) {
  const [family, action] = operation.split('.');
  if (action === 'list') return provider === 'claude' && family === 'sessions' ? {} : { limit: 5 };
  const id = fixtureId(fixtures, provider, family);
  if (!id) return undefined;
  if (action === 'search') return { query: id, ...(provider === 'fabric' ? {} : { limit: 5 }) };
  if (operation === 'sessions.read') return ['codex', 'claude'].includes(provider) ? { id, maxChars: 4000 } : { id, limit: 5 };
  if (['sessions.status', 'projects.read'].includes(operation)) return { id };
  return undefined;
}

export async function runMatrix({ connect = connectOperator, fixtures = {}, mutations = [], allowMutations = false, runKey,
  now = utc, routes = true } = {}) {
  if (!object(fixtures)) throw new Error('Fixture registry must be an object.');
  if (!Array.isArray(mutations) || mutations.length > 24) throw new Error('Mutation plan must contain at most 24 entries.');
  const planned = mutations.map(entry => validateMutation(entry, fixtures, { allowMutations, runKey }));
  if (new Set(planned.map(entry => `${entry.provider}:${entry.operation}`)).size !== planned.length)
    throw new Error('Only one mutation per provider/operation is allowed in one plan.');
  const report = { schema: 'switchboard.live-matrix.v1', startedAt: now(), finishedAt: null,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, protocolVersion },
    mode: planned.length ? 'explicit_fixture_mutations' : 'read_only',
    acceptance: 'Bearer-harness calls do not establish originating-agent acceptance or final agent-work completion.',
    providers: {}, protocol: {}, routes: [], evidence: [], summary: {} };
  let evidenceIndex = 0;
  async function probe(cell, caller, scope, method, params, rpc) {
    const started = Date.now(), at = now();
    try {
      const raw = await rpc(method, params);
      const result = outcome(raw, { receipt: scope === 'operation_receipt' });
      const evidence = { id: `e${++evidenceIndex}`, at, caller, scope, method,
        requestSha256: sha(params), durationMs: Date.now() - started, ...evidenceSummary(raw) };
      report.evidence.push(evidence);
      delete cell.code;
      Object.assign(cell, result, { observedAt: at, evidence: [evidence.id] });
      return raw;
    } catch (error) {
      const code = safeCode(error?.code);
      const authOrTransport = /auth|token|connect|offline|ECONN|HTTP (401|403|502|503|504)/i.test(`${error?.code} ${error?.message}`);
      Object.assign(cell, { status: authOrTransport ? 'blocked' : 'live_fail', code, observedAt: at });
      report.evidence.push({ id: `e${++evidenceIndex}`, at, caller, scope, method, requestSha256: sha(params),
        durationMs: Date.now() - started, errorCode: code });
      cell.evidence = [`e${evidenceIndex}`];
    }
  }
  const operatorCell = { status: 'not_run' };
  let rpc;
  try { rpc = await connect('operator'); } catch { operatorCell.status = 'blocked'; operatorCell.code = 'operator_connection_unavailable'; }
  report.protocol['operator.connection'] = operatorCell;
  if (rpc) {
    const discovery = await probe(operatorCell, 'operator', 'hub_protocol', 'server/discover', {}, rpc);
    for (const method of ['tools/list', 'prompts/list', 'resources/list']) {
      const cell = report.protocol[method] = { status: 'not_run' };
      await probe(cell, 'operator', 'hub_protocol', method, {}, rpc);
    }
    report.protocol['events/list'] = { status: object(discovery?.capabilities?.events) ? 'not_run' : 'unsupported' };
    if (object(discovery?.capabilities?.events)) await probe(report.protocol['events/list'], 'operator', 'hub_protocol', 'events/list', {}, rpc);
    const cell = report.protocol['resources/read'] = { status: 'not_run' };
    await probe(cell, 'operator', 'hub_protocol', 'resources/read', { uri: 'switchboard://agents' }, rpc);
    const agentsCell = report.protocol.agents_list = { status: 'not_run' };
    const agentsRaw = await probe(agentsCell, 'operator', 'hub_registry', 'tools/call', { name: 'agents_list', arguments: {} }, rpc);
    const agents = nativeValue(agentsRaw)?.agents ?? [];
    for (const id of PROVIDERS) {
      const descriptor = agents.find(agent => agent.id === id);
      const p = report.providers[id] = { fixtureRecorded: !!fixtureId(fixtures, id),
        runtime: { serverVersion: descriptor?.serverInfo?.version ?? null, desktopVersions: descriptor?.runtimeVersions ?? [],
          observedAt: descriptor?.observedAt ?? null, availability: descriptor?.availability ?? 'unknown' },
        operations: {}, nativeTools: [], features: {}, discovery: { status: 'not_run' } };
      const capRaw = await probe(p.discovery, 'operator', 'hub_registry', 'tools/call', { name: 'capabilities_get', arguments: { provider: id } }, rpc);
      const cap = nativeValue(capRaw);
      const declarations = Array.isArray(cap?.operations) ? cap.operations : [];
      if (declarations.length > 128 || (cap?.nativeTools?.length ?? 0) > 1000) throw new Error('Declared matrix exceeds bounded report capacity.');
      for (const operation of new Set([...OPERATIONS, ...declarations.map(x => x.operation)])) {
        const declared = declarations.find(x => x.operation === operation);
        const cell = p.operations[operation] = { status: declared?.support === 'unsupported' ? 'unsupported' : declared ? 'not_run' : 'blocked',
          declaredSupport: declared?.support ?? 'unknown', availability: declared?.availability ?? 'unknown',
          ...(declared?.nativeTool ? { nativeTool: declared.nativeTool } : {}), evidence: [] };
        if (cell.status === 'unsupported' && ['offline', 'auth_required', 'unknown'].includes(descriptor?.availability)) {
          cell.status = 'blocked'; cell.code = 'provider_unavailable_capability_unknown'; continue;
        }
        if (cell.status === 'unsupported') continue;
        if (!declared) { cell.code = 'capability_not_observed'; continue; }
        const [family, action] = operation.split('.');
        if (!['list', 'search', 'read', 'status'].includes(action)) { cell.code = 'mutation_not_requested'; continue; }
        const input = readInput(id, operation, fixtures);
        if (!input) { cell.status = 'blocked'; cell.code = 'exact_fixture_not_recorded'; continue; }
        await probe(cell, 'operator', 'provider_call', 'tools/call', { name: family, arguments: { provider: id, action, input } }, rpc);
      }
      p.nativeTools = (cap?.nativeTools ?? []).map(entry => ({ name: entry.name, declaredReadOnly: entry.readOnly === true,
        status: 'not_run', code: 'catalog_presence_is_not_functional_acceptance' }));
      for (const [name, declared] of Object.entries(featureDeclarations(descriptor))) {
        const cell = p.features[name] = { status: declared === false ? 'unsupported' : 'not_run', declared,
          code: declared === false ? 'not_declared_by_provider' : 'requires_explicit_client_journey' };
        if (declared === false && ['offline', 'auth_required', 'unknown'].includes(descriptor?.availability)) {
          cell.status = 'blocked'; cell.code = 'provider_unavailable_capability_unknown';
        }
        if (declared && ['mcp.prompts.list', 'mcp.resources.list'].includes(name)) {
          await probe(cell, 'operator', 'provider_call', 'tools/call', { name: name.includes('prompts') ? 'provider_prompts' : 'provider_resources', arguments: { provider: id } }, rpc);
        }
      }
    }
    const fixtureProvider = PROVIDERS.find(id => fixtureId(fixtures, id));
    report.protocol['prompts/get'] = { status: fixtureProvider ? 'not_run' : 'blocked', code: 'exact_fixture_not_recorded' };
    if (fixtureProvider) await probe(report.protocol['prompts/get'], 'operator', 'hub_protocol', 'prompts/get', {
      name: 'coordinate_review', arguments: { provider: fixtureProvider, sessionId: fixtureId(fixtures, fixtureProvider), work: 'Read-only live matrix prompt rendering; do not execute this prompt.' },
    }, rpc);
    for (const name of ['subscriptions.notification', 'tasks.lifecycle', 'elicitation.human_response', 'events.webhook_delivery'])
      report.protocol[name] = { status: 'not_run', code: 'requires_explicit_end_to_end_client_journey' };
    for (const entry of planned) {
      const cell = report.providers[entry.provider].operations[entry.operation];
      if (!cell || cell.status === 'unsupported' || cell.declaredSupport === 'unknown') continue;
      const [family, action] = entry.operation.split('.');
      const raw = await probe(cell, 'operator', 'fixture_mutation_receipt', 'tools/call', {
        name: family, arguments: { provider: entry.provider, action, input: entry.input },
      }, rpc);
      const receipt = nativeValue(raw);
      cell.requestId = entry.input.requestId;
      if (identifier(receipt?.operation?.id)) {
        cell.operationId = receipt.operation.id;
        const receiptCell = { status: 'not_run' };
        await probe(receiptCell, 'operator', 'operation_receipt', 'tools/call', {
          name: 'operations_get', arguments: { operationId: receipt.operation.id },
        }, rpc);
        cell.evidence.push(...(receiptCell.evidence ?? []));
        // A receipt read can refine a pending result, but cannot overwrite an
        // already observed native rejection with a later successful wrapper.
        if (!['live_fail', 'unsupported'].includes(cell.status)) {
          cell.status = receiptCell.status;
          cell.code = receiptCell.code;
        }
      }
    }
  } else {
    for (const id of PROVIDERS) report.providers[id] = { runtime: {}, operations: Object.fromEntries(OPERATIONS.map(operation => [operation,
      { status: 'blocked', code: 'operator_connection_unavailable' }])), nativeTools: [], features: {} };
  }
  for (const caller of PROVIDERS) {
    let client;
    if (routes) { try { client = await connect(caller); } catch {} }
    for (const target of PROVIDERS) {
      const route = { caller, target, harness: { status: routes ? 'blocked' : 'not_run', code: routes ? 'caller_connection_unavailable' : 'route_probe_disabled' },
        originatingAgent: { status: 'not_run', code: 'bearer_harness_is_not_agent_origin_acceptance' } };
      report.routes.push(route);
      if (!client) continue;
      const capabilityCell = { status: 'not_run' };
      const capRaw = await probe(capabilityCell, caller, 'caller_grant', 'tools/call', { name: 'capabilities_get', arguments: { provider: target } }, client);
      if (capabilityCell.status !== 'live_pass') { route.harness = capabilityCell; continue; }
      const declared = nativeValue(capRaw)?.operations?.find(x => x.operation === 'sessions.list');
      if (!declared || declared.support === 'unsupported') {
        const unavailable = ['offline', 'auth_required', 'unknown'].includes(nativeValue(capRaw)?.provider?.availability);
        route.harness = { status: unavailable ? 'blocked' : 'unsupported',
          code: unavailable ? 'provider_unavailable_capability_unknown' : 'sessions_list_not_declared' }; continue;
      }
      await probe(route.harness, caller, 'bearer_to_provider_read', 'tools/call', {
        name: 'sessions', arguments: { provider: target, action: 'list', input: readInput(target, 'sessions.list', fixtures) },
      }, client);
    }
  }
  const cells = [...Object.values(report.protocol), ...Object.values(report.providers).flatMap(p =>
    [...Object.values(p.operations), ...Object.values(p.features), ...p.nativeTools]), ...report.routes.flatMap(r => [r.harness, r.originatingAgent])];
  for (const status of STATUSES) report.summary[status] = cells.filter(cell => cell.status === status).length;
  const countStatuses = values => Object.fromEntries(STATUSES.map(status => [status, values.filter(cell => cell.status === status).length]));
  report.coverage = {
    providerOperations: countStatuses(Object.values(report.providers).flatMap(p => Object.values(p.operations))),
    nativeTools: countStatuses(Object.values(report.providers).flatMap(p => p.nativeTools)),
    bearerRoutes: countStatuses(report.routes.map(route => route.harness)),
    originatingAgents: countStatuses(report.routes.map(route => route.originatingAgent)),
  };
  report.finishedAt = now();
  return report;
}

export async function persistReport(report, output) {
  const data = JSON.stringify(report, null, 2) + '\n';
  if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new Error('Report exceeds 2 MiB; nothing written.');
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, data, { mode: 0o600, flag: 'wx' });
}

async function jsonFile(filename, optional = false) {
  try {
    const text = await readFile(filename, 'utf8');
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Input exceeds 1 MiB.');
    return JSON.parse(text);
  } catch (error) { if (optional && error.code === 'ENOENT') return {}; throw error; }
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--allow-mutations') options.allowMutations = true;
    else if (arg === '--no-routes') options.routes = false;
    else if (['--fixtures', '--out', '--mutations', '--run-key'].includes(arg) && args[index + 1] && !args[index + 1].startsWith('--')) options[arg.slice(2)] = args[++index];
    else throw new Error('Usage: matrix.mjs [--fixtures FILE] [--out NEW_FILE] [--no-routes] [--mutations PLAN --allow-mutations --run-key STABLE_KEY]');
  }
  if (options.allowMutations && !options.mutations) throw new Error('--allow-mutations requires an explicit plan.');
  const output = options.out ?? path.resolve('evidence/live', `matrix-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const fixtures = await jsonFile(options.fixtures ?? 'evidence/live/fixtures.json', !options.fixtures);
  const mutations = options.mutations ? await jsonFile(options.mutations) : [];
  const report = await runMatrix({ fixtures, mutations, allowMutations: options.allowMutations, runKey: options['run-key'], routes: options.routes });
  await persistReport(report, output);
  console.log(JSON.stringify({ report: output, mode: report.mode, summary: report.summary,
    agentOriginAcceptance: 'not_run', note: report.acceptance }, null, 2));
  if (report.summary.live_fail) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // CLI diagnostics are only our fixed validation messages, never tool replies.
    const safe = error.message.startsWith('Usage:') || /^(Mutation|Invalid mutation|This operation|Unknown mutation|Rename |Stop |Delete |Only one mutation|Report exceeds|Input exceeds|--allow-mutations)/.test(error.message);
    console.error(safe ? error.message : 'Live matrix could not finish. Check local configuration and input files; no raw error payload was printed.');
    process.exitCode = 1;
  });
}
