#!/usr/bin/env node
// Transparent stdio-to-HTTP MCP bridge. Each configured host has its own local
// token file. Protocol messages and streamed notifications retain their IDs.
import readline from 'node:readline';
import { readFile } from 'node:fs/promises';

const endpoint = process.env.SWITCHBOARD_URL ?? 'http://127.0.0.1:8796/mcp';
const token = (await readFile(process.env.SWITCHBOARD_TOKEN_FILE, 'utf8')).trim();
const pending = new Map();
const write = item => process.stdout.write(JSON.stringify(item) + '\n');
async function forward(item) {
  if (item.method === 'notifications/cancelled') {
    pending.get(item.params?.requestId)?.abort();
    return;
  }
  const key = item.id ?? Symbol('notification');
  if (pending.has(key)) {
    write({ jsonrpc: '2.0', id: item.id, error: { code: -32600, message: 'Request ID is already in flight.' } });
    return;
  }
  const controller = new AbortController(); pending.set(key, controller);
  try {
    const version = item.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` };
    if (version) {
      headers['mcp-protocol-version'] = version; headers['mcp-method'] = item.method;
      const name = item.params?.name ?? item.params?.uri ?? item.params?.taskId;
      if (name !== undefined) headers['mcp-name'] = name;
    }
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(item), redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error(`Switchboard returned HTTP ${response.status}.`);
    if (response.status === 202 || response.status === 204) return;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      let buffer = ''; const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 4 * 1024 * 1024) throw new Error('MCP response exceeded the frame limit.');
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) write(JSON.parse(data));
        }
      }
    } else write(await response.json());
  } catch (error) {
    if (item.id !== undefined && !controller.signal.aborted) write({ jsonrpc: '2.0', id: item.id,
      error: { code: -32000, message: error.message } });
  } finally { pending.delete(key); }
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  if (Buffer.byteLength(line) > 1024 * 1024) { input.close(); return; }
  try { void forward(JSON.parse(line)); }
  catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); }
});
input.on('close', () => { for (const controller of pending.values()) controller.abort(); });
