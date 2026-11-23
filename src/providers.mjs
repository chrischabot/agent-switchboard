import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { call as desktopCall, desktopTools } from '../server.mjs';
import { CodexIPC, codexStop, desktopEventFile } from '../switchboard.mjs';
import { watchJsonLines } from './local-event-source.mjs';
import { AcpProvider } from './acp.mjs';
import { fault } from './store.mjs';

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
// Only an explicit native read-only annotation makes a call passive. Anything
// else is journaled as a mutation with a caller-stable request ID.
export const providerToolReadOnly = tool => tool?.annotations?.readOnlyHint === true;
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
  async refresh() {
    if (this.id !== 'codex') return this.connect();
    // Owner discovery can wait for every recent thread's desktop window. The
    // registry needs transport liveness; sessions_query does the owner scan.
    const ipc = new CodexIPC();
    try {
      await ipc.connect();
      this.descriptor.availability = 'ready';
      this.descriptor.observedAt = new Date().toISOString();
      this.descriptor.observation = 'desktop_ipc';
    } finally { ipc.close(); }
  }
  async call(name, args, context) {
    const result = await (name === 'codex_stop' ? codexStop(args) : desktopCall(name, args, context));
    if (name === `${this.id}_list`) {
      // A successful Codex owner-discovery connection is reachable even when
      // this bounded recent-session window contains no desktop-owned threads.
      this.descriptor.availability = this.id === 'codex' || result.sessions.length ? 'ready' : 'offline';
      this.descriptor.discovery = { examined: result.examined ?? result.sessions.length, found: result.sessions.length, complete: this.id !== 'codex' };
      this.descriptor.observedAt = new Date().toISOString();
      this.descriptor.discoveryObservedAt = this.descriptor.observedAt;
      this.descriptor.observation = 'session_discovery';
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
    this.descriptor = { id, kind: 'mcp', support: 'native', availability: 'offline', verification: 'declared',
      limitations: ['Passthrough only: provider_call, resources, prompts, Tasks and elicitation relay. No normalized session operations or session events.'] };
    this.sessionEventTypes = [];
    this.sessionEventSource = null;
  }
  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async refresh() {
    if (this.connecting || !this.client) return this.connect();
    // Do not reopen healthy transports: subscriptions and provider calls may
    // be using them. Modern MCP replaces ping with server/discover.
    const client = this.client;
    if (client.getDiscoverResult?.()) await client.discover({ timeout: 4000 });
    else await client.ping({ timeout: 4000 });
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
  isReadOnly(name) {
    return providerToolReadOnly(this.catalog.find(t => t.name === name));
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
  async close() { await this.client?.close(); }
}

export async function loadProviders(config) {
  const providers = new Map();
  for (const [id, provider] of Object.entries(config.providers)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw fault('invalid_config', 'Invalid provider identity.');
    if (provider.kind === 'desktop' && !['codex', 'claude'].includes(id))
      throw fault('invalid_config', 'Desktop providers must be named codex or claude.');
    if (provider.kind === 'acp' && id !== 'antigravity')
      throw fault('invalid_config', 'The ACP adapter is written for Antigravity; name the provider antigravity.');
    providers.set(id, provider.kind === 'desktop' ? new DesktopProvider(id)
      : provider.kind === 'acp' ? new AcpProvider(id, provider) : new McpProvider(id, provider));
  }
  return providers;
}
