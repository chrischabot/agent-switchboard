import { fault } from './store.mjs';
import { toolValue, providerToolReadOnly } from './providers.mjs';
import { createHash, randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { ElicitRequestV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
const inputValidator = new Ajv2020({ strict: false, allErrors: true });

const compact = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
function nativeMessageId(caller, provider, target, requestId) {
  const bytes = createHash('sha256').update(JSON.stringify([
    'switchboard.native-message.v1', caller, provider, target.kind, target.id, requestId,
  ])).digest().subarray(0, 16);
  // Maestro's emitter validates UUID v4 even though its ingress accepts any
  // string. Preserve deterministic retry identity while satisfying that wire
  // contract; this is an identifier, never an authentication credential.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function dispatchStatus(result) {
  let value = result, rejected = false, uncertain = false, receipt = false;
  const seen = new Set();
  for (let depth = 0; value && typeof value === 'object' && !Array.isArray(value); depth++) {
    if (depth >= 32 || seen.has(value)) return 'outcome_unknown';
    seen.add(value);
    // Inspect the envelope before unwrapping: toolValue intentionally returns
    // only the useful payload and would otherwise discard native isError.
    rejected ||= value.isError === true || value.error != null && value.error !== false ||
      ['rejected', 'unavailable', 'conflict', 'failed', 'error'].includes(value.status) ||
      ['refused', 'rejected', 'dropped'].includes(value.state);
    uncertain ||= value.status === 'outcome_unknown' ||
      ['sent', 'transport-sent', 'unknown', 'held'].includes(value.state);
    // Fabric operator receipts preserve admission separately from MCP success.
    // already_terminal is a completed stop, while not_accepted is a refusal.
    if (typeof value.operationId === 'string' && typeof value.action === 'string') {
      rejected ||= value.observed === 'not_accepted';
      uncertain ||= ['unknown', 'uncertain'].includes(value.observed);
    }
    const unwrapped = toolValue(value);
    if (unwrapped !== value) { value = unwrapped; continue; }
    if (value.kind === 'result') {
      if (!value.value || typeof value.value !== 'object' || Array.isArray(value.value)) return 'outcome_unknown';
      value = value.value;
      continue;
    }
    if (value.kind === 'operation') {
      if (!value.operation || typeof value.operation !== 'object' || Array.isArray(value.operation)) return 'outcome_unknown';
      receipt = true;
      value = value.operation;
      continue;
    }
    if (receipt) {
      rejected ||= value.status === 'cancelled';
      uncertain ||= !['succeeded', 'failed', 'cancelled'].includes(value.status);
      receipt = false;
      value = value.result;
      continue;
    }
    break;
  }
  // Only known response/receipt envelopes are inspected. Error records inside
  // successful transcript or other domain data do not describe this dispatch.
  return uncertain ? 'outcome_unknown' : rejected ? 'failed' : 'succeeded';
}
const common = ['sessions.list', 'sessions.search', 'sessions.read', 'sessions.status',
  'sessions.create', 'sessions.message', 'sessions.steer', 'sessions.stop', 'sessions.resume',
  'sessions.rename', 'sessions.archive', 'sessions.restore', 'sessions.delete_preview', 'sessions.delete',
  'projects.list', 'projects.search', 'projects.read', 'projects.create', 'projects.update', 'projects.archive', 'projects.restore', 'projects.delete_preview', 'projects.delete'];
const commonKeys = {
  'sessions.list': 'limit cursor', 'sessions.search': 'query limit cursor', 'sessions.read': 'id limit cursor maxChars',
  'sessions.status': 'id', 'sessions.create': 'name text projectId requestId',
  'sessions.message': 'id text requestId', 'sessions.steer': 'id text requestId expectedTurnId',
  'sessions.stop': 'id requestId expectedTurnId', 'sessions.resume': 'id requestId',
  'sessions.rename': 'id name requestId', 'sessions.archive': 'id requestId', 'sessions.restore': 'id requestId',
  'sessions.delete_preview': 'id requestId', 'sessions.delete': 'id requestId confirmationToken',
  'projects.list': 'limit cursor', 'projects.search': 'query limit cursor', 'projects.read': 'id',
  'projects.create': 'name description requestId', 'projects.update': 'id requestId',
  'projects.archive': 'id requestId', 'projects.restore': 'id requestId', 'projects.delete_preview': 'id requestId', 'projects.delete': 'id requestId confirmationToken',
};
const providerKeys = {
  maestro: { 'sessions.create': 'agentId budget seedAttachments', 'sessions.message': 'attachments mode',
    'sessions.steer': 'attachments', 'projects.update': 'name description sortOrder' },
  fabric: { 'sessions.create': 'agentType', 'sessions.resume': 'text', 'projects.create': 'mode', 'projects.update': 'brief expectedRevision' },
};
const inputFields = {
  id: { type: 'string', minLength: 1, description: 'Exact native session/thread or project ID from this provider. Always use input.id, never sessionId, threadId or target.' },
  requestId: { type: 'string', minLength: 8, maxLength: 200, description: 'Caller-stable identity for this mutation. Reuse only for the same intent and arguments; uncertain writes are never automatically resent.' },
  text: { type: 'string', minLength: 1, description: 'Message or first prompt. Fabric resume requires a new prompt in this same thread.' },
  name: { type: 'string', minLength: 1, description: 'New name/title.' },
  query: { type: 'string', minLength: 1 },
  limit: { type: 'integer', minimum: 1, maximum: 2000 },
  cursor: { type: 'string', minLength: 1, description: 'Opaque cursor returned by the same provider operation.' },
  maxChars: { type: 'integer', minimum: 1, maximum: 100000 },
  projectId: { type: 'string', minLength: 1 },
  expectedTurnId: { type: 'string', minLength: 1, description: 'Exact active turn ID, obtained from native status before steering or stopping.' },
  confirmationToken: { type: 'string', minLength: 1, description: 'Native deletion preview token bound to this exact target. Maestro calls this previewId.' },
  description: { type: 'string' },
  agentId: { type: 'string', minLength: 1 },
  agentType: { type: 'string', minLength: 1 },
  mode: { type: 'string', minLength: 1 },
  sortOrder: { type: 'number' },
  expectedRevision: { type: 'number' },
  brief: { type: 'object', description: 'Fabric project brief fields; provider_tools_list with name project_update_brief exposes the complete nested native schema.' },
  budget: { type: 'object', properties: { amount: { type: 'number', minimum: 0 }, currency: { const: 'USD' },
    period: { type: 'string', enum: ['hour', 'day', 'total'] }, includesDescendants: { type: 'boolean' } },
    required: ['amount', 'currency', 'period'], additionalProperties: false },
};
const attachment = { type: 'object', properties: { attachmentId: { type: 'string', minLength: 1 },
  name: { type: 'string', minLength: 1 }, sha256: { type: 'string', minLength: 1 } },
  required: ['attachmentId'], additionalProperties: false };
inputFields.attachments = inputFields.seedAttachments = { type: 'array', maxItems: 100, items: attachment };

function inputKeys(provider, operation) {
  let allowed = `${commonKeys[operation] ?? ''} ${providerKeys[provider]?.[operation] ?? ''}`.split(' ');
  if (provider === 'codex' || provider === 'claude') {
    if (operation === 'sessions.list') allowed = provider === 'codex' ? ['limit'] : [];
    if (operation === 'sessions.read') allowed = ['id', 'maxChars'];
    if (operation === 'sessions.steer') allowed = ['id', 'text', 'requestId'];
  } else if (operation === 'sessions.read') allowed = allowed.filter(k => k !== 'maxChars');
  if (provider === 'fabric' && operation === 'sessions.search') allowed = ['query'];
  if (provider === 'maestro' && ['sessions.steer', 'sessions.stop'].includes(operation)) allowed = allowed.filter(k => k !== 'expectedTurnId');
  return [...new Set(allowed.filter(Boolean))];
}

// No arguments: visible input fields for the generic sessions/projects tools.
// Exact provider+operation: the validated normalized contract in capabilities_get.
export function normalizedInputSchema(provider, operation) {
  if (operation && !Object.hasOwn(commonKeys, operation)) throw fault('unsupported', 'Unknown normalized operation.');
  const keys = operation ? inputKeys(provider, operation) : Object.keys(inputFields);
  const properties = Object.fromEntries(keys.map(key => [key, structuredClone(inputFields[key])]));
  const required = [];
  if (operation) {
    const [family, action] = operation.split('.');
    if (!['list', 'search', 'create'].includes(action)) required.push('id');
    if (action === 'search') required.push('query');
    if (!['list', 'search', 'read', 'status'].includes(action) && !(provider === 'fabric' && action === 'delete_preview')) required.push('requestId');
    if (['message', 'steer'].includes(action) || provider === 'fabric' && operation === 'sessions.resume') required.push('text');
    if (action === 'rename' || family === 'projects' && action === 'create') required.push('name');
    if (action === 'delete') required.push('confirmationToken');
    if (provider === 'fabric' && operation === 'projects.update') required.push('brief');
    if (provider === 'fabric' && ['sessions.steer', 'sessions.stop'].includes(operation) || provider === 'codex' && operation === 'sessions.stop') required.push('expectedTurnId');
    if (properties.limit) properties.limit.maximum = provider === 'codex' ? 100 : provider === 'fabric' && operation === 'sessions.read' ? 2000 : 200;
    if (properties.description && provider === 'maestro') properties.description.maxLength = 300;
    if (properties.description && provider === 'fabric') properties.description.maxLength = 32000;
    if (properties.mode && provider === 'fabric') properties.mode = { type: 'string', enum: ['manual', 'coordinated'], default: 'manual' };
  }
  return { type: 'object', properties, required, additionalProperties: false,
    description: operation ? `${provider} ${operation}: normalized arguments; native nested payload schemas are also validated.`
      : 'Normalized arguments. Use capabilities_get(provider) for this operation\'s required fields. Session and project targets are always input.id.' };
}
const normalizedValidators = new Map();
function validateInput(provider, operation, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('invalid_arguments', 'input must be an object.');
  const schema = normalizedInputSchema(provider, operation);
  const allowed = Object.keys(schema.properties);
  for (const key of Object.keys(input)) if (!allowed.includes(key))
    throw fault('unsupported_argument', `${provider} ${operation} does not consume ${key}; it was not sent.`);
  if (!['list', 'search', 'create'].includes(operation.split('.')[1]) && (typeof input.id !== 'string' || !input.id))
    throw fault('invalid_target', 'An exact native id is required.');
  const key = `${provider}:${operation}`;
  if (!normalizedValidators.has(key)) normalizedValidators.set(key, inputValidator.compile(schema));
  const validate = normalizedValidators.get(key);
  if (!validate(input)) throw fault('invalid_arguments', inputValidator.errorsText(validate.errors));
}

export class Broker {
  constructor(store, providers, config) {
    this.store = store; this.providers = providers; this.config = config;
    this.running = new Map(); this.closing = false;
    this.discovery = new Map();
  }
  principal(id) {
    const principal = this.config.clients[id];
    if (!principal) throw fault('unauthorized', 'Unknown client.');
    return { id, ...principal };
  }
  provider(caller, id) {
    const principal = this.principal(caller);
    if (!principal.providers.includes(id)) throw fault('forbidden', 'This client has no grant for that provider.');
    const provider = this.providers.get(id);
    if (!provider) throw fault('not_found', 'Unknown provider.');
    return provider;
  }
  async agents(caller) {
    const providers = this.principal(caller).providers.map(id => this.providers.get(id)).filter(Boolean);
    return Promise.all(providers.map(async p => {
      // Share slow discovery across callers. A response deadline must not start
      // another connection attempt while the previous one is still in flight.
      let pending = this.discovery.get(p);
      if (!pending) {
        pending = Promise.resolve().then(async () => {
          if (!p.refresh) return 'refresh_unsupported';
          await p.refresh();
          return null;
        }).catch(error => error.code === 'auth_required' || p.descriptor.availability === 'auth_required'
          ? 'auth_required' : 'refresh_failed');
        this.discovery.set(p, pending);
        pending.then(() => { if (this.discovery.get(p) === pending) this.discovery.delete(p); });
      }
      let timer;
      const timeoutMs = Math.min(15000, Math.max(1, this.config.agentRefreshTimeoutMs ?? 5000));
      const error = await Promise.race([pending, new Promise(resolve => {
        timer = setTimeout(() => resolve('refresh_timeout'), timeoutMs);
      })]).finally(() => clearTimeout(timer));
      return { ...p.descriptor, toolCount: p.catalog.length,
        checkedAt: new Date().toISOString(), freshness: error ? 'stale' : 'fresh',
        ...(error ? { availability: error === 'auth_required' ? 'auth_required' : 'unknown', refreshError: error } : {}) };
    }));
  }
  capabilities(caller, id) {
    const p = this.provider(caller, id);
    return { provider: p.descriptor, operations: common.map(operation => {
      let binding;
      try { binding = this.bind(id, operation, { id: 'capability-probe', requestId: 'capability-probe',
        text: 'probe', name: 'probe', expectedTurnId: 'probe', confirmationToken: 'probe' }, caller); } catch {}
      const nativeTool = binding && p.catalog.find(t => t.name === binding.name);
      const supported = !!nativeTool;
      return { operation, support: supported ? p.descriptor.support : 'unsupported',
        availability: supported ? p.descriptor.availability : 'unsupported', verification: 'declared',
        ...(supported ? { nativeTool: binding.name, semantics: binding.semantics ?? operation,
          readOnly: providerToolReadOnly(id, nativeTool, binding.args),
          ...(providerToolReadOnly(id, nativeTool, binding.args) && !operation.endsWith('delete_preview') ? { readTool: operation.startsWith('sessions.') ? 'sessions_query' : 'projects_query' } : {}),
          inputSchema: normalizedInputSchema(id, operation) } : {}),
        retry: supported ? 'broker_deduplicated_no_uncertain_replay' : 'unavailable' };
    }), nativeTools: p.catalog.map(t => ({ name: t.name, readOnly: t.annotations?.readOnlyHint === true })) };
  }
  tools(caller, provider, name, after = 0, limit = 30) {
    const p = this.provider(caller, provider);
    if (name) {
      const tool = p.catalog.find(t => t.name === name);
      if (!tool) throw fault('not_found', 'Native tool not found.');
      return { tools: [tool] };
    }
    const page = p.catalog.slice(after, after + Math.min(50, limit));
    return { tools: page.map(({ name, description, annotations }) => ({ name, description, annotations })),
      ...(after + page.length < p.catalog.length ? { nextCursor: after + page.length } : {}) };
  }
  bind(provider, operation, input, caller) {
    const [family, action] = operation.split('.');
    const { id, requestId, text, name, expectedTurnId, ...options } = input;
    const thread = id;
    if (provider === 'codex' || provider === 'claude') {
      if (family !== 'sessions') throw fault('unsupported', 'Desktop projects are not exposed by this connector.');
      if (action === 'list') return { name: `${provider}_list`, args: provider === 'codex' ? { limit: options.limit ?? 10 } : {} };
      if (action === 'read' || action === 'status') return { name: `${provider}_read`, args: compact({ sessionId: id, maxChars: options.maxChars }),
        semantics: action === 'status' ? 'recent_transcript_projection_may_lag_active_turn' : 'bounded_recent_transcript_projection' };
      if (action === 'message' || (action === 'steer' && provider === 'codex')) return {
        name: `${provider}_send`, args: { sessionId: id, text, ...(provider === 'codex' ? { mode: action === 'steer' ? 'steer' : 'start' } : {}) },
        semantics: provider === 'claude' ? 'peer_inbox_next_opportunity' : action === 'steer' ? 'active_steer' : 'idle_start' };
      if (action === 'stop' && provider === 'codex') return { name: 'codex_stop', args: { sessionId: id, expectedTurnId } };
      throw fault('unsupported', 'This desktop operation has no externally callable native binding.');
    }
    if (provider === 'fabric') {
      const bindings = {
        'sessions.list': ['thread_list', compact({ limit: options.limit, cursor: options.cursor })],
        'sessions.search': ['fabric_resolve', { query: options.query, kind: 'thread' }],
        'sessions.read': ['thread_transcript', compact({ thread, limit: options.limit, beforeItemId: options.cursor })],
        'sessions.status': ['thread_status', { thread }],
        'sessions.create': ['thread_create', compact({ title: name, project: options.projectId, agentType: options.agentType, prompt: text, operationKey: requestId })],
        'sessions.message': ['thread_start', { thread, prompt: text, idempotencyKey: requestId }],
        'sessions.steer': ['thread_steer', { thread, message: text, expectedTurnId }],
        'sessions.stop': ['thread_cancel', { thread, turnId: expectedTurnId, confirm: true }],
        'sessions.resume': ['thread_start', { thread, prompt: text, idempotencyKey: requestId }],
        'sessions.archive': ['thread_archive', { thread, archived: true, confirm: true }],
        'sessions.restore': ['thread_archive', { thread, archived: false, confirm: true }],
        'sessions.delete_preview': ['thread_delete_preview', { threadIds: [id] }],
        'sessions.delete': ['thread_delete', { threadIds: [id], confirmationToken: options.confirmationToken }],
        'projects.list': ['project_list', compact({ limit: options.limit, cursor: options.cursor })],
        'projects.read': ['project_snapshot', { projectId: id, view: 'overview' }],
        'projects.create': ['project_create_coordinated', compact({ name, description: options.description, idempotencyKey: requestId, mode: options.mode ?? 'manual' })],
        'projects.update': ['project_update_brief', compact({ projectId: id, idempotencyKey: requestId, brief: options.brief, expectedRevision: options.expectedRevision })],
        'projects.archive': ['project_lifecycle', { projectId: id, action: 'archive', idempotencyKey: requestId }],
        'projects.restore': ['project_lifecycle', { projectId: id, action: 'restore', idempotencyKey: requestId }],
        'projects.delete_preview': ['project_lifecycle_preview', { projectId: id }],
        'projects.delete': ['project_lifecycle', { projectId: id, action: 'delete', idempotencyKey: requestId, confirmationToken: options.confirmationToken }],
      };
      const b = bindings[operation];
      if (b) return { name: b[0], args: b[1], ...(action === 'resume' ? { semantics: 'new_turn_in_same_thread_requires_prompt' }
        : operation === 'projects.restore' ? { semantics: 'restore_archived_project_to_paused_without_resuming' }
        : operation === 'sessions.search' ? { semantics: 'bounded_name_resolution_without_pagination' }
        : operation === 'projects.read' ? { semantics: 'coordinated_project_snapshot_requires_coordination' } : {}) };
    }
    if (provider === 'maestro') {
      const target = { connectionId: 'maestro', kind: family === 'projects' ? 'project' : 'session', id };
      const mutation = { requestId };
      if (action === 'list') return { name: 'maestro_find', args: { action: 'list', connectionId: 'maestro',
        kinds: [target.kind], page: compact({ limit: options.limit, cursor: options.cursor }) } };
      if (action === 'search') return { name: 'maestro_find', args: { action: 'search', connectionId: 'maestro', query: options.query,
        kinds: [target.kind], page: compact({ limit: options.limit, cursor: options.cursor }) } };
      if (action === 'read') return family === 'sessions'
        ? { name: 'maestro_read', args: { action: 'get', target, stream: 'conversation', page: compact({ limit: options.limit, cursor: options.cursor }) } }
        : { name: 'maestro_inspect', args: { action: 'get', target, view: 'summary' } };
      if (action === 'status') return { name: 'maestro_inspect', args: { action: 'get', target, view: 'summary' } };
      if (action === 'create') return { name: family === 'projects' ? 'maestro_project' : 'maestro_session', args: compact({
        action, connectionId: 'maestro', mutation, name, ...(family === 'sessions' ? { firstMessage: text,
          budget: options.budget, agentId: options.agentId, seedAttachments: options.seedAttachments,
          project: options.projectId ? { connectionId: 'maestro', kind: 'project', id: options.projectId } : undefined } : { description: options.description }) }) };
      if (action === 'message' || action === 'steer') return { name: 'maestro_send', args: { action: 'message', target, mutation,
        intent: action === 'steer' ? 'steer' : 'new_turn', text, clientMessageId: nativeMessageId(caller, provider, target, requestId),
        ...compact({ attachments: options.attachments, mode: options.mode }) } };
      if (action === 'stop' || action === 'resume') return { name: 'maestro_control', args: { action, target, mutation } };
      if (['rename', 'update', 'archive', 'restore', 'delete_preview', 'delete'].includes(action)) return {
        name: family === 'projects' ? 'maestro_project' : 'maestro_session',
        args: compact({ action, target, mutation, ...(action === 'rename' || action === 'update' ? { name, description: options.description, sortOrder: options.sortOrder } : {}), previewId: options.confirmationToken }) };
    }
    throw fault('unsupported', `${operation} is not available for ${provider}. Use capabilities_get for the exact surface.`);
  }
  async invoke(caller, providerId, name, args, requestId, context = {}) {
    const provider = this.provider(caller, providerId);
    if (provider.descriptor.availability !== 'ready' && provider.connect) await provider.connect();
    const tool = provider.catalog.find(t => t.name === name);
    if (!tool) throw fault('unsupported', `Tool ${name} is not in the connected provider catalog.`);
    provider.validate?.(name, args);
    if (providerToolReadOnly(providerId, tool, args)) {
      const value = await provider.call(name, args, context);
      if (value?.resultType !== 'input_required') return { kind: 'result', value };
      const { operation, fresh } = this.store.submit(caller, requestId ?? randomUUID(), providerId, { name, args, context });
      if (fresh) this.stageInput(operation, value, ['queued']);
      return { kind: 'operation', operation: this.store.get(caller, operation.id) };
    }
    // The native arguments (including native idempotency keys) are part of the
    // fingerprint. Transport context is not caller-selectable permission data.
    const { operation, fresh } = this.store.submit(caller, requestId, providerId, { name, args, context });
    if (fresh) this.dispatch(operation);
    return { kind: 'operation', operation: this.store.get(caller, operation.id) };
  }
  async operate(caller, provider, operation, input, context) {
    this.provider(caller, provider);
    validateInput(provider, operation, input);
    if (['sessions.steer', 'sessions.stop'].includes(operation) && provider === 'fabric' && !input.expectedTurnId)
      throw fault('missing_turn_guard', 'Read status and supply expectedTurnId before steering or stopping.');
    const binding = this.bind(provider, operation, input, caller);
    return this.invoke(caller, provider, binding.name, binding.args, input.requestId, context);
  }
  async notify(caller, provider, input, context) {
    this.provider(caller, provider);
    // Recovery reuses the already-journaled dispatch, including the disposition
    // chosen before a crash. A later idle/busy state cannot resend the ping.
    const row = this.store.db.prepare('SELECT id FROM operations WHERE principal=? AND request_key=?').get(caller, input.requestId);
    if (row) {
      const old = this.store.get(caller, row.id), args = old.request.args;
      if (old.provider !== provider || (args.sessionId ?? args.thread ?? args.target?.id) !== input.id
        || (args.text ?? args.prompt ?? args.message) !== input.text)
        throw fault('conflict', 'This notification requestId already identifies another dispatch.');
      return { kind: 'operation', operation: old };
    }
    let action = 'message', expectedTurnId;
    if (['codex', 'fabric', 'maestro'].includes(provider)) {
      const result = await this.operate(caller, provider, 'sessions.status', { id: input.id }, context);
      if (result.kind !== 'result') throw fault('status_unavailable', 'Native notification disposition requires a passive status result.');
      const value = toolValue(result.value);
      if (result.value?.isError || value?.error) throw fault('status_unavailable', 'Native status failed; the notification was not dispatched.');
      const state = provider === 'codex' ? value.latestTurn?.status
        : provider === 'fabric' ? value.turn?.status ?? value.turn?.state : value.data?.state?.status;
      const active = ['inProgress', 'running', 'active', 'working', 'waiting', 'initializing'].includes(state);
      const idle = ['completed', 'failed', 'cancelled', 'interrupted', 'ready', 'stopped', 'paused', 'none'].includes(state);
      const empty = provider === 'codex' && value.latestTurn == null && value.sessionId === input.id && value.source === 'read-only local history projection'
        || provider === 'maestro' && value.data?.state?.seq === 0 && value.data.state.status === null && value.data.state.thread_id === input.id;
      if (!active && !idle && !empty) throw fault('status_unavailable', 'The native destination state is unrecognized; the notification was not dispatched.');
      if (active) {
        action = 'steer';
        if (provider === 'fabric') {
          expectedTurnId = value.turn?.turnId ?? value.cursor?.turnId;
          if (!expectedTurnId) throw fault('missing_turn_guard', 'The active destination has no exact turn ID; the notification was not dispatched.');
        }
      }
    }
    return this.operate(caller, provider, `sessions.${action}`, { ...input, ...(expectedTurnId ? { expectedTurnId } : {}) }, context);
  }
  dispatch(operation) {
    if (this.closing || this.running.has(operation.id)) return;
    if (!this.store.transition(operation.principal, operation.id, ['queued'], 'dispatching')) return;
    const work = (async () => {
      try {
        const provider = this.provider(operation.principal, operation.provider);
        const { name, args, context } = operation.request;
        const result = await provider.call(name, args, { ...context, ...(operation.result?.continuation ? { continuation: operation.result.continuation } : {}) });
        if (result?.resultType === 'input_required') {
          this.stageInput(operation, result, ['dispatching']);
          return;
        }
        const status = dispatchStatus(result);
        this.store.transition(operation.principal, operation.id, ['dispatching'], status, result);
      } catch (error) {
        this.store.transition(operation.principal, operation.id, ['dispatching'], 'outcome_unknown',
          { code: error.code ?? 'provider_error', message: 'Provider dispatch failed; delivery may be unknown. Inspect the destination before retrying.' });
      }
    })().finally(() => {
      this.running.delete(operation.id);
      if (!this.closing) {
        const latest = this.store.get(operation.principal, operation.id);
        if (latest.status === 'queued') this.dispatch(latest);
      }
    });
    this.running.set(operation.id, work);
  }
  stageInput(operation, result, from) {
    const requests = result.inputRequests;
    const rounds = (operation.result?.rounds ?? 0) + 1;
    if (rounds > 8 || !requests || Object.keys(requests).length > 16 || Buffer.byteLength(JSON.stringify(requests)) > 256 * 1024)
      throw fault('input_limit', 'Provider input requests exceeded the bounded continuation contract.');
    const inputRequests = {}, questionMap = {};
    for (const [key, request] of Object.entries(requests)) {
      if (request.method !== 'elicitation/create' || !request.params || !['form', 'url'].includes(request.params.mode ?? 'form'))
        throw fault('unsupported_input', 'Only human elicitation input is supported by this connector.');
      if (!ElicitRequestV2Schema.safeParse(request).success) throw fault('unsupported_input', 'Provider elicitation does not match the current MCP form/URL schema.');
      const params = { ...request.params, message: `[${operation.provider}: ${operation.request.name}] ${request.params.message}` };
      const id = this.store.ask(operation.principal, operation.id, params);
      questionMap[id] = key; inputRequests[id] = { method: 'elicitation/create', params };
    }
    if (!Object.keys(inputRequests).length) throw fault('unsupported_input', 'A state-only continuation needs an explicit supported workflow.');
    this.store.transition(operation.principal, operation.id, from, 'waiting_input', {
      inputRequests, questionMap, requestState: result.requestState, rounds,
    });
  }
  validateAnswer(caller, id, response) {
    const question = this.store.question(caller, id);
    if (!['accept', 'decline', 'cancel'].includes(response?.action)) throw fault('invalid_answer', 'Invalid elicitation response.');
    if (response.action === 'accept' && question.request.requestedSchema) {
      const validate = inputValidator.compile(question.request.requestedSchema);
      if (!validate(response.content)) throw fault('invalid_answer', inputValidator.errorsText(validate.errors));
    }
    return question;
  }
  answer(caller, id, response) {
    const question = this.validateAnswer(caller, id, response);
    this.store.answer(caller, id, response);
    if (question.operation_id) this.resumeAnswered(caller, question.operation_id);
  }
  updateTask(caller, id, responses) {
    const operation = this.store.get(caller, id);
    if (operation.status !== 'waiting_input') throw fault('no_pending_input', 'This task has no pending input requests.');
    if (!responses || typeof responses !== 'object' || Array.isArray(responses) || !Object.keys(responses).length || Object.keys(responses).length > 16)
      throw fault('invalid_answer', 'Supply between one and sixteen input responses.');
    for (const key of Object.keys(responses)) if (!Object.hasOwn(operation.result.questionMap, key)) throw fault('invalid_answer', 'Response does not belong to this task.');
    for (const [key, response] of Object.entries(responses)) this.validateAnswer(caller, key, response);
    this.store.answerMany(caller, responses);
    this.resumeAnswered(caller, id);
  }
  task(caller, id) {
    const operation = this.store.get(caller, id);
    if (operation.status === 'waiting_input') operation.result.inputRequests = Object.fromEntries(
      Object.entries(operation.result.inputRequests).filter(([key]) => !this.store.question(caller, key).response));
    return operation;
  }
  resumeAnswered(caller, id) {
    const operation = this.store.get(caller, id);
    if (operation.status !== 'waiting_input') return;
    const inputResponses = {};
    for (const [questionId, upstreamId] of Object.entries(operation.result.questionMap)) {
      const question = this.store.question(caller, questionId);
      if (!question.response) return;
      inputResponses[upstreamId] = question.response;
    }
    const next = { ...operation.result, continuation: { inputResponses,
      ...(operation.result.requestState ? { requestState: operation.result.requestState } : {}) } };
    if (this.store.transition(caller, id, ['waiting_input'], 'queued', next)) this.dispatch(this.store.get(caller, id));
  }
  cancel(caller, id) {
    const operation = this.store.get(caller, id);
    if (operation.status === 'queued') this.store.transition(caller, id, ['queued'], 'cancelled');
    else if (!['cancelled', 'succeeded', 'failed'].includes(operation.status))
      throw fault('cannot_cancel_dispatch', 'The provider may have received this operation. Stop the exact native session/turn separately.');
    return this.store.get(caller, id);
  }
  recover() { for (const operation of this.store.recover()) this.dispatch(operation); }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.providers.values()].map(p => p.close()));
    await Promise.allSettled([...this.running.values()]);
  }
}
