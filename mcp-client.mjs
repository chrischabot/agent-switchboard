#!/usr/bin/env node
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// Diagnostic client for the same stdio MCP entry installed in both applications.
// It launches only Switchboard, never another model or provider session.
export async function invokeMcp(name, args = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const reader = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
  const fail = (error) => {
    for (const callback of [...pending.values()]) callback({ error: { message: error.message } });
  };
  child.on('error', fail);
  child.on('exit', (code) => fail(new Error(`MCP child exited (${code}): ${stderr}`)));
  reader.on('line', (line) => {
    try { const item = JSON.parse(line); pending.get(item.id)?.(item); }
    catch { fail(new Error('Invalid MCP JSON response.')); }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('MCP response timeout; write outcome may be unknown.'));
    }, 120000);
    pending.set(id, (item) => {
      clearTimeout(timer); pending.delete(id);
      if (item.error) reject(new Error(item.error.message));
      else resolve(item.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const initialized = await send('initialize', { protocolVersion: '2024-11-05',
      capabilities: {}, clientInfo: { name: 'switchboard-verifier', version: '0.1.0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const catalog = await send('tools/list', {});
    if (!catalog.tools.some((tool) => tool.name === name)) throw new Error('Tool absent from MCP catalog.');
    const result = await send('tools/call', { name, arguments: args });
    return { server: initialized.serverInfo, toolCount: catalog.tools.length, tool: name, result };
  } finally {
    child.stdin.end();
    reader.close();
    child.kill();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await invokeMcp(process.argv[2], JSON.parse(process.argv[3] || '{}')))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
