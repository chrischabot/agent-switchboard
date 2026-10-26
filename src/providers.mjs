import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { call as desktopCall, desktopTools } from '../server.mjs';
import { codexStop, desktopEventFile } from '../switchboard.mjs';
import { watchJsonLines } from './local-event-source.mjs';
import { normalizeSessionEvent } from './session-events.mjs';
import { fault } from './store.mjs';

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
export function providerToolReadOnly(id, tool, args) {
  if (tool.annotations?.readOnlyHint === true) return true;
  if (id !== 'maestro' || args.mutation) return false;
  const actions = {
    maestro_connect: ['status'], maestro_inspect: ['get', 'snapshot', 'blocking'],
    maestro_questions: ['list', 'get'], maestro_actions: ['list'],
    maestro_operations: ['list', 'get'], maestro_integrations: ['list', 'get'],
  };
  return actions[tool.name]?.includes(args.action) === true;
}
export const toolValue = result => {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.filter(x => x.type === 'text').map(x => x.text).join('\n');
  if (text) { try { return JSON.parse(text); } catch { return { text }; } }
  return result;
};

export class DesktopProvider {
  constructor(id) {
    this.id = id;
    this.sessionEventSource = 'native transcript append notifications; observation may lag generation';
    this.sessionEventTypes = id === 'codex'
      ? ['session.turn.started', 'session.turn.ended', 'session.block.completed', 'session.error', 'session.source.gap']
      : ['session.turn.ended', 'session.block.completed', 'session.error', 'session.source.gap'];
    this.descriptor = { id, kind: 'desktop', support: 'adapted', availability: 'unknown',
      verification: 'declared', limitations: ['Only existing locally owned sessions; lifecycle capabilities are individually declared.'] };
    this.catalog = desktopTools.filter(t => t.name.startsWith(`${id}_`));
    if (id === 'codex') this.catalog.push({ name: 'codex_stop', description: 'Interrupt the exact active turn through its desktop owner. Requires expectedTurnId.',
      inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, expectedTurnId: { type: 'string', minLength: 1 } },
        required: ['sessionId', 'expectedTurnId'], additionalProperties: false }, annotations: { readOnlyHint: false } });
  }
  async connect() {
    return this.call(`${this.id}_list`, this.id === 'codex' ? { limit: 10 } : {});
  }
  async refresh() { return this.connect(); }
  async call(name, args, context) {
    const result = await (name === 'codex_stop' ? codexStop(args) : desktopCall(name, args, context));
    if (name === `${this.id}_list`) {
      // A successful Codex owner-discovery connection is reachable even when
      // this bounded recent-session window contains no desktop-owned threads.
      this.descriptor.availability = this.id === 'codex' || result.sessions.length ? 'ready' : 'offline';
      this.descriptor.discovery = { examined: result.examined ?? result.sessions.length, found: result.sessions.length, complete: this.id !== 'codex' };
      this.descriptor.observedAt = new Date().toISOString();
      this.descriptor.runtimeVersions = [...new Set(result.sessions.map(x => x.version).filter(Boolean))];
    }
    return result;
  }
  async close() {}
  async watchSession(sessionId, options) { return watchJsonLines(await desktopEventFile(this.id, sessionId), this.id, options); }
}

// Credentials are resolved only in this local adapter and never appear in the
// registry. Re-read on every HTTP request so the owning client's refresh is used.
async function credentialHeaders(config) {
  if (config.tokenFile) return { authorization: `Bearer ${(await readFile(config.tokenFile, 'utf8')).trim()}` };
  if (config.codexCredential) {
    const values = JSON.parse(await readFile(config.codexCredential.file, 'utf8'));
    const entry = Object.values(values).find(x => x.server_name === config.codexCredential.serverName && x.server_url === config.url);
    if (!entry?.access_token) throw fault('auth_required', 'The configured MCP client has no credential for this exact endpoint.');
    return { authorization: `Bearer ${entry.access_token}` };
  }
  return {};
}

export class McpProvider {
  constructor(id, config) {
    this.id = id; this.config = config; this.catalog = []; this.validators = new Map();
    this.descriptor = { id, kind: 'mcp', support: 'native', availability: 'offline', verification: 'declared' };
  }
  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async refresh() {
    if (this.connecting || !this.client) return this.connect();
    // Do not reopen healthy transports: subscriptions and provider calls may
    // be using them. A ping checks this connection without replaying any work.
    const client = this.client;
    await client.ping({ timeout: 4000 });
    if (this.client !== client) throw fault('connection_changed', 'Provider connection changed during discovery.');
    this.descriptor.availability = 'ready';
    this.descriptor.observedAt = new Date().toISOString();
    return this.descriptor;
  }
  async open() {
    await this.client?.close();
    const client = new Client({ name: 'agent-switchboard', version: '0.2.0' },
      { versionNegotiation: { mode: this.config.supportsInputRequired ? { pin: '2026-07-28' } : 'auto', probe: { timeoutMs: 10000 } },
        capabilities: this.config.supportsInputRequired ? { elicitation: { form: {}, url: {} } } : {},
        inputRequired: { autoFulfill: false }, listMaxPages: 20 });
    const transport = this.config.url ? new StreamableHTTPClientTransport(new URL(this.config.url), {
      fetch: async (input, init = {}) => {
        // Never follow a redirect with provider credentials.
        const headers = new Headers(init.headers);
        for (const [key, value] of Object.entries(await credentialHeaders(this.config))) headers.set(key, value);
        return fetch(input, { ...init, headers, redirect: 'error' });
      },
    }) : new StdioClientTransport({ command: this.config.command, args: this.config.args,
      env: { ...process.env, ...this.config.env }, stderr: 'pipe' });
    try {
      if (this.config.url) await credentialHeaders(this.config);
      await client.connect(transport, { timeout: 15000 });
      const { tools } = await client.listTools();
      this.catalog = tools;
      this.validators = new Map(tools.map(t => [t.name, ajv.compile(t.inputSchema)]));
      this.client = client;
      client.onclose = () => {
        if (this.client !== client) return;
        this.client = null;
        this.descriptor.availability = 'offline';
      };
      this.descriptor = { ...this.descriptor, availability: 'ready', serverInfo: client.getServerVersion(),
        capabilities: client.getServerCapabilities(), observedAt: new Date().toISOString() };
      this.sessionEventTypes = this.id === 'maestro' && tools.some(t => t.name === 'maestro_watch')
        ? ['session.turn.ended', 'session.block.created', 'session.block.updated', 'session.state.changed', 'session.error', 'session.input_required', 'session.source.gap']
        : this.id === 'fabric' && tools.some(t => t.name === 'thread_events_wait')
          ? ['session.turn.started', 'session.turn.ended', 'session.block.created', 'session.block.updated', 'session.block.completed', 'session.error', 'session.input_required', 'session.source.gap'] : [];
      this.sessionEventSource = this.id === 'maestro' ? 'native broker journal and event-driven wait; gaps remain explicit'
        : 'native Fabric stream; requires thread_events_wait in the connected Tutti catalog';
      return this.descriptor;
    } catch (error) {
      await transport.close();
      this.descriptor.availability = error.code === 'auth_required' || /401|403|auth|token/i.test(error.message) ? 'auth_required' : 'offline';
      throw error;
    }
  }
  validate(name, args) {
    const validate = this.validators.get(name);
    if (!validate) throw fault('unsupported', `Unknown ${this.id} tool: ${name}`);
    if (!validate(args)) throw fault('invalid_arguments', ajv.errorsText(validate.errors));
  }
  isReadOnly(name, args) {
    return providerToolReadOnly(this.id, this.catalog.find(t => t.name === name), args);
  }
  async call(name, args, context = {}) {
    if (!this.client) await this.connect();
    this.validate(name, args);
    return this.client.callTool({ name, arguments: args, ...context.continuation }, { timeout: 120000, allowInputRequired: true });
  }
  async resources(params) { return this.client.listResources(params); }
  async readResource(params) { return this.client.readResource(params); }
  async prompts(params) { return this.client.listPrompts(params); }
  async getPrompt(params) { return this.client.getPrompt(params); }
  async watchSession(sessionId, { cursor, onEvent, onError }) {
    if (!this.client) await this.connect();
    const controller = new AbortController();
    const name = this.id === 'maestro' ? 'maestro_watch' : 'thread_events_wait';
    if (!this.sessionEventTypes?.length || !this.catalog.some(tool => tool.name === name))
      throw fault('unsupported', 'The connected provider does not expose a session event source.');
    let current = cursor;
    let ready, failed;
    const established = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    let first = true;
    const work = (async () => {
      while (!controller.signal.aborted) {
        const args = this.id === 'maestro' ? { action: 'changes', targets: [{ connectionId: 'maestro', kind: 'session', id: sessionId }],
          ...(this.catalog.find(t => t.name === 'maestro_watch')?.inputSchema?.properties?.projection?.enum?.includes('metadata') ? { projection: 'metadata' } : {}),
          ...(current ? { cursor: current } : {}), waitMs: first ? 0 : 30000, events: ['progress', 'question', 'failure', 'completion', 'budget', 'configuration', 'roster'], page: { limit: 50 } }
          : { thread: sessionId, ...(current !== undefined ? { afterSequence: current } : {}), waitMs: first ? 0 : 12000, limit: 200 };
        const raw = await this.client.callTool({ name, arguments: args }, { timeout: 45000, signal: controller.signal });
        const value = toolValue(raw);
        if (raw.isError || value?.error || ['rejected', 'unavailable'].includes(value?.status)) throw new Error('Native event source refused the watch.');
        const data = this.id === 'maestro' ? value.data : value;
        if (!Array.isArray(data?.events) || this.id === 'maestro' && typeof data.cursor !== 'string'
          || this.id === 'fabric' && !Number.isSafeInteger(data.nextAfterSequence))
          throw new Error('Native event replay is not a bounded event page.');
        const events = (data.events ?? []).flatMap(event => normalizeSessionEvent(this.id, event, String(event.seq ?? event.sequence)));
        if (data.gap || data.resyncRequired || data.limits?.snapshotRequired)
          events.unshift({ name: 'session.source.gap', scope: 'source', sourceId: `gap:${data.cursor ?? data.nextAfterSequence}` });
        current = data.cursor ?? data.nextAfterSequence ?? current;
        onEvent(events, current);
        if (first) { first = false; ready(); }
      }
    })().catch(error => { if (first) failed(error); if (!controller.signal.aborted) onError(); });
    await established;
    return async () => { controller.abort(); await work; };
  }
  async close() { await this.client?.close(); }
}

export async function loadProviders(config) {
  const providers = new Map();
  for (const [id, provider] of Object.entries(config.providers)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw fault('invalid_config', 'Invalid provider identity.');
    providers.set(id, provider.kind === 'desktop' ? new DesktopProvider(id) : new McpProvider(id, provider));
  }
  return providers;
}
