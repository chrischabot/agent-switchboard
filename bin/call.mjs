#!/usr/bin/env node
// Operator CLI. Credentials stay in the private local config; arguments come
// from stdin so native prompts and other private payloads need not be in argv.
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function connectOperator(caller = 'operator') {
  const config = JSON.parse(await readFile(process.env.SWITCHBOARD_CONFIG ?? path.join(os.homedir(), '.local/state/agent-switchboard/config.json'), 'utf8'));
  const token = (await readFile(config.clients[caller].tokenFile, 'utf8')).trim();
  let id = 0;
  return async function rpc(method, params = {}) {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': method };
    const name = params.name ?? params.uri ?? params.taskId;
    if (name) headers['mcp-name'] = name;
    const res = await fetch(`http://127.0.0.1:${config.port}/mcp`, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'switchboard-operator', version: '0.2.0' },
        'io.modelcontextprotocol/clientCapabilities': {}, ...params._meta } } }), signal: AbortSignal.timeout(60000) });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Switchboard HTTP ${res.status}`);
    const body = res.headers.get('content-type')?.includes('text/event-stream')
      ? raw.split(/\r?\n/).filter(x => x.startsWith('data: ')).map(x => JSON.parse(x.slice(6))).find(x => x.id === id)
      : JSON.parse(raw);
    if (!body || body.error) throw new Error(body?.error?.message ?? 'Missing RPC result');
    return body.result;
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const args = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const rpc = await connectOperator(process.env.SWITCHBOARD_CALLER);
  console.log(JSON.stringify(await rpc(process.argv[2] ?? 'tools/call', args), null, 2));
}
