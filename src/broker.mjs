import { fault } from './store.mjs';
import { toolValue, providerToolReadOnly } from './providers.mjs';
import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { ElicitRequestV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
const inputValidator = new Ajv2020({ strict: false, allErrors: true });

const compact = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
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
export const sessionOperations = ['sessions.list', 'sessions.read', 'sessions.status', 'sessions.create',
  'sessions.message', 'sessions.steer', 'sessions.stop', 'sessions.resume'];
const commonKeys = {
  'sessions.list': 'limit cursor', 'sessions.read': 'id maxChars', 'sessions.status': 'id',
  'sessions.create': 'cwd text requestId', 'sessions.message': 'id text requestId',
  'sessions.steer': 'id text requestId', 'sessions.stop': 'id requestId expectedTurnId', 'sessions.resume': 'id requestId',
};
const inputFields = {
  id: { type: 'string', minLength: 1, description: 'Exact native session ID from this provider. Always use input.id, never sessionId, threadId or target.' },
  requestId: { type: 'string', minLength: 8, maxLength: 200, description: 'Caller-stable identity for this mutation. Reuse only for the same intent and arguments; uncertain writes are never automatically resent.' },
  text: { type: 'string', minLength: 1, maxLength: 32000, description: 'Message, or the first prompt of a new session.' },
  limit: { type: 'integer', minimum: 1, maximum: 200 },
  cursor: { type: 'string', minLength: 1, description: 'Opaque cursor returned by the same provider operation.' },
  maxChars: { type: 'integer', minimum: 1, maximum: 100000 },
  expectedTurnId: { type: 'string', minLength: 1, description: 'Exact active turn ID: from native status for Codex, from the message receipt or status for Antigravity.' },
  cwd: { type: 'string', minLength: 1, pattern: '^/', description: 'Absolute working directory for a new session.' },
};

function inputKeys(provider, operation) {
  let allowed = (commonKeys[operation] ?? '').split(' ');
  if (operation === 'sessions.list') allowed = provider === 'codex' ? ['limit'] : provider === 'claude' ? [] : allowed;
  return [...new Set(allowed.filter(Boolean))];
}

// No arguments: visible input fields for the generic sessions tools.
// Exact provider+operation: the validated normalized contract in capabilities_get.
export function normalizedInputSchema(provider, operation) {
  if (operation && !Object.hasOwn(commonKeys, operation)) throw fault('unsupported', 'Unknown normalized operation.');
  const keys = operation ? inputKeys(provider, operation) : Object.keys(inputFields);
  const properties = Object.fromEntries(keys.map(key => [key, structuredClone(inputFields[key])]));
  const required = [];
  if (operation) {
    const action = operation.split('.')[1];
    if (!['list', 'create'].includes(action)) required.push('id');
    if (!['list', 'read', 'status'].includes(action)) required.push('requestId');
    if (['message', 'steer'].includes(action)) required.push('text');
    if (action === 'create') required.push('cwd');
    if (action === 'stop') required.push('expectedTurnId');
    if (properties.limit) properties.limit.maximum = provider === 'codex' ? 100 : 200;
  }
  return { type: 'object', properties, required, additionalProperties: false,
    description: operation ? `${provider} ${operation}: normalized arguments; native payload schemas are also validated.`
      : 'Normalized arguments. Use capabilities_get(provider) for this operation\'s required fields. Session targets are always input.id.' };
}
const normalizedValidators = new Map();
function validateInput(provider, operation, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('invalid_arguments', 'input must be an object.');
  const schema = normalizedInputSchema(provider, operation);
  const allowed = Object.keys(schema.properties);
  for (const key of Object.keys(input)) if (!allowed.includes(key))
    throw fault('unsupported_argument', `${provider} ${operation} does not consume ${key}; it was not sent.`);
  if (!['list', 'create'].includes(operation.split('.')[1]) && (typeof input.id !== 'string' || !input.id))
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
    // Adapters that raise human questions (Antigravity permission requests)
    // need the durable question store and its answers.
    for (const provider of providers.values()) provider.attach?.(this);
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
    return { provider: p.descriptor, operations: sessionOperations.map(operation => {
      let binding;
      try { binding = this.bind(id, operation, { id: 'capability-probe', requestId: 'capability-probe',
        text: 'probe', expectedTurnId: 'probe', cwd: '/capability-probe' }, caller); } catch {}
      const nativeTool = binding && p.catalog.find(t => t.name === binding.name);
      const supported = !!nativeTool, readOnly = supported && providerToolReadOnly(nativeTool);
      return { operation, support: supported ? p.descriptor.support : 'unsupported',
        availability: supported ? p.descriptor.availability : 'unsupported', verification: 'declared',
        ...(supported ? { nativeTool: binding.name, semantics: binding.semantics ?? operation, readOnly,
          ...(readOnly ? { readTool: 'sessions_query' } : {}),
          inputSchema: normalizedInputSchema(id, operation) } : p.unsupportedReasons?.[operation] ? { reason: p.unsupportedReasons[operation] } : {}),
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
  bind(provider, operation, input) {
    const [family, action] = operation.split('.');
    const { id, text, expectedTurnId, ...options } = input;
    if (family !== 'sessions') throw fault('unsupported', 'Only session operations are normalized.');
    if (provider === 'codex' || provider === 'claude') {
      if (action === 'list') return { name: `${provider}_list`, args: provider === 'codex' ? { limit: options.limit ?? 10 } : {} };
      if (action === 'read' || action === 'status') return { name: `${provider}_read`, args: compact({ sessionId: id, maxChars: options.maxChars }),
        semantics: action === 'status' ? 'recent_transcript_projection_may_lag_active_turn' : 'bounded_recent_transcript_projection' };
      if (action === 'message' || (action === 'steer' && provider === 'codex')) return {
        name: `${provider}_send`, args: { sessionId: id, text, ...(provider === 'codex' ? { mode: action === 'steer' ? 'steer' : 'start' } : {}) },
        semantics: provider === 'claude' ? 'peer_inbox_next_opportunity' : action === 'steer' ? 'active_steer' : 'idle_start' };
      if (action === 'stop' && provider === 'codex') return { name: 'codex_stop', args: { sessionId: id, expectedTurnId } };
      throw fault('unsupported', 'This desktop operation has no externally callable native binding.');
    }
    if (provider === 'antigravity') {
      const bindings = {
        list: ['antigravity_list', compact({ cursor: options.cursor, limit: options.limit }), 'acp_session_list'],
        read: ['antigravity_read', compact({ sessionId: id, maxChars: options.maxChars }), 'bounded_history_replay_from_session_load'],
        status: ['antigravity_status', { sessionId: id }, 'broker_started_turns_only'],
        message: ['antigravity_prompt', { sessionId: id, text }, 'new_prompt_turn_in_broker_acp_process'],
        stop: ['antigravity_cancel', { sessionId: id, expectedTurnId }, 'cancel_broker_started_turn_only'],
        create: ['antigravity_new', compact({ cwd: options.cwd, text }), 'new_session_optional_first_prompt'],
        resume: ['antigravity_resume', { sessionId: id }, 'open_in_broker_acp_process_without_replay'],
      };
      const b = bindings[action];
      if (b) return { name: b[0], args: b[1], semantics: b[2] };
    }
    throw fault('unsupported', `${operation} is not available for ${provider}. Use capabilities_get for the exact surface.`);
  }
  async invoke(caller, providerId, name, args, requestId, context = {}) {
    const provider = this.provider(caller, providerId);
    if (provider.descriptor.availability !== 'ready' && provider.connect) await provider.connect();
    const tool = provider.catalog.find(t => t.name === name);
    if (!tool) throw fault('unsupported', `Tool ${name} is not in the connected provider catalog.`);
    provider.validate?.(name, args);
    if (providerToolReadOnly(tool)) {
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
    const binding = this.bind(provider, operation, input);
    return this.invoke(caller, provider, binding.name, binding.args, input.requestId, context);
  }
  async notify(caller, provider, input, context) {
    this.provider(caller, provider);
    // Recovery reuses the already-journaled dispatch, including the disposition
    // chosen before a crash. A later idle/busy state cannot resend the ping.
    const row = this.store.db.prepare('SELECT id FROM operations WHERE principal=? AND request_key=?').get(caller, input.requestId);
    if (row) {
      const old = this.store.get(caller, row.id), args = old.request.args;
      if (old.provider !== provider || args.sessionId !== input.id || args.text !== input.text)
        throw fault('conflict', 'This notification requestId already identifies another dispatch.');
      return { kind: 'operation', operation: old };
    }
    // Codex distinguishes starting an idle turn from steering an active one.
    // Claude queues peer input itself, and Antigravity refuses a second prompt
    // while a broker-started turn runs (a failed receipt, never a silent drop).
    let action = 'message';
    if (provider === 'codex') {
      const result = await this.operate(caller, provider, 'sessions.status', { id: input.id }, context);
      if (result.kind !== 'result') throw fault('status_unavailable', 'Native notification disposition requires a passive status result.');
      const value = toolValue(result.value);
      if (result.value?.isError || value?.error) throw fault('status_unavailable', 'Native status failed; the notification was not dispatched.');
      const state = value.latestTurn?.status;
      const active = ['inProgress', 'running', 'active'].includes(state);
      const idle = ['completed', 'failed', 'cancelled', 'interrupted'].includes(state);
      const empty = value.latestTurn == null && value.sessionId === input.id && value.source === 'read-only local history projection';
      if (!active && !idle && !empty) throw fault('status_unavailable', 'The native destination state is unrecognized; the notification was not dispatched.');
      if (active) action = 'steer';
    }
    return this.operate(caller, provider, `sessions.${action}`, input, context);
  }
  dispatch(operation) {
    if (this.closing || this.running.has(operation.id)) return;
    if (!this.store.transition(operation.principal, operation.id, ['queued'], 'dispatching')) return;
    const work = (async () => {
      try {
        const provider = this.provider(operation.principal, operation.provider);
        const { name, args, context } = operation.request;
        // The operation identity is dispatch context, not part of the request
        // fingerprint: adapters use it to attribute human questions.
        const result = await provider.call(name, args, { ...context, operation: { id: operation.id, principal: operation.principal },
          ...(operation.result?.continuation ? { continuation: operation.result.continuation } : {}) });
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
    for (const provider of this.providers.values()) provider.answered?.(caller, id, response);
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
