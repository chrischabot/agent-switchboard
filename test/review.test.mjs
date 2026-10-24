import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import Ajv2020 from 'ajv/dist/2020.js';
import { Store } from '../src/store.mjs';
import { Broker } from '../src/broker.mjs';
import { McpProvider } from '../src/providers.mjs';

function brokerFixture(t, id, tools, response = { status: 'accepted' }) {
  const calls = [];
  const store = new Store(':memory:');
  // Keep the production adapter's validation and action classification; only
  // its downstream transport is replaced by the controlled service response.
  const provider = new McpProvider(id, {});
  provider.descriptor = { id, availability: 'ready', support: 'native' };
  provider.catalog = tools;
  const ajv = new Ajv2020({ strict: false });
  provider.validators = new Map(tools.map(definition => [definition.name, ajv.compile(definition.inputSchema)]));
  provider.call = async (name, args) => { calls.push({ name, args }); return response; };
  const broker = new Broker(store, new Map([[id, provider]]), { clients: { caller: { providers: [id] } } });
  t.after(async () => {
    await Promise.allSettled([...broker.running.values()]);
    await broker.close();
    store.close();
  });
  return { calls, store, broker };
}

const tool = (name, readOnlyHint = false) => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint } });

test('normalized session creation preserves an explicit native budget or refuses before dispatch', async t => {
  const f = brokerFixture(t, 'maestro', [tool('maestro_session')]);
  const budget = { amount: 5, currency: 'USD', period: 'total' };
  let rejected;
  try {
    await f.broker.operate('caller', 'maestro', 'sessions.create', {
      requestId: 'budget-preservation-1', name: 'fixture', text: 'test only', budget,
    });
  } catch (error) { rejected = error; }
  if (rejected) {
    assert.ok(['invalid_arguments', 'unsupported'].includes(rejected.code));
    assert.equal(f.calls.length, 0);
    return;
  }
  await Promise.all([...f.broker.running.values()]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args.budget, budget, 'Accepting an explicit budget must not silently remove it');
});

test('normalized messages preserve native attachments or refuse before dispatch', async t => {
  const f = brokerFixture(t, 'maestro', [tool('maestro_send')]);
  const attachments = [{ attachmentId: 'fixture-attachment', name: 'style-guide.md' }];
  let rejected;
  try {
    await f.broker.operate('caller', 'maestro', 'sessions.message', {
      id: 'fixture-session', requestId: 'attachment-preservation-1', text: 'Read the attached guide', attachments,
    });
  } catch (error) { rejected = error; }
  if (rejected) {
    assert.ok(['invalid_arguments', 'unsupported'].includes(rejected.code));
    assert.equal(f.calls.length, 0);
    return;
  }
  await Promise.all([...f.broker.running.values()]);
  assert.deepEqual(f.calls[0].args.attachments, attachments);
});

test('normalized status reads do not become mutations because their native tool has a mutating sibling action', async t => {
  // Maestro advertises inspect as mutating because it also exposes hydrate;
  // its get action is a passive read and requires no mutation/requestId.
  const f = brokerFixture(t, 'maestro', [tool('maestro_inspect', false)], { status: 'ok', state: 'idle' });
  const result = await f.broker.operate('caller', 'maestro', 'sessions.status', { id: 'fixture-session' });
  assert.equal(result.kind, 'result');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args.action, 'get');
  assert.equal(f.store.list('caller').length, 0);
});

test('a Claude peer refusal is a failed dispatch receipt, never success', async t => {
  // This is the current desktop adapter's actual refusal shape, rather than
  // an invented generic provider status envelope.
  const f = brokerFixture(t, 'claude', [tool('claude_send')], {
    sessionId: 'fixture-session', msgId: 'fixture-message', state: 'refused',
    receipts: [{ detail: 'refused' }], completion: 'not-verified; inspect transcript for the receiving agent reply',
  });
  const result = await f.broker.invoke('caller', 'claude', 'claude_send', {
    sessionId: 'fixture-session', text: 'fixture',
  }, 'refusal-request-1');
  await Promise.all([...f.broker.running.values()]);
  assert.equal(f.store.get('caller', result.operation.id).status, 'failed');
});

test('a provider unavailable during startup reconnects when a later authorized read is requested',
  { timeout: 15000 }, async t => {
    let online = false, calls = 0;
    const handler = createMcpHandler(() => {
      const server = new Server({ name: 'reconnect-fixture', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler('tools/list', async () => ({ tools: [tool('fixture_read', true)] }));
      server.setRequestHandler('tools/call', async () => {
        calls++;
        return { content: [{ type: 'text', text: 'fresh-read' }] };
      });
      return server;
    });
    const nodeHandler = toNodeHandler(handler);
    const http = createServer((req, res) => {
      if (!online) { res.writeHead(503); res.end('fixture offline'); }
      else void nodeHandler(req, res);
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const provider = new McpProvider('fixture', { url: `http://127.0.0.1:${http.address().port}/mcp` });
    const store = new Store(':memory:');
    const broker = new Broker(store, new Map([['fixture', provider]]), { clients: { caller: { providers: ['fixture'] } } });
    t.after(async () => {
      await broker.close();
      await handler.close();
      http.closeAllConnections();
      await new Promise(resolve => http.close(resolve));
      store.close();
    });
    await assert.rejects(provider.connect());
    assert.equal(provider.descriptor.availability, 'offline');
    online = true;
    const result = await broker.invoke('caller', 'fixture', 'fixture_read', {});
    assert.equal(result.kind, 'result');
    assert.equal(calls, 1);
    assert.equal(provider.descriptor.availability, 'ready');
  });

test('a previously connected stdio provider can restart for the next read after its process exits',
  { timeout: 15000 }, async t => {
    const script = `
      import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server'))};
      import { serveStdio } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
      serveStdio(() => {
        const server = new Server({name:'exit-fixture',version:'1'}, {capabilities:{tools:{}}});
        server.setRequestHandler('tools/list', async () => ({tools:[{
          name:'fixture_read',inputSchema:{type:'object'},annotations:{readOnlyHint:true}
        }]}));
        server.setRequestHandler('tools/call', async () => {
          setTimeout(() => process.exit(0), 10);
          return {content:[{type:'text',text:String(process.pid)}]};
        });
        return server;
      });
    `;
    const provider = new McpProvider('fixture', { command: process.execPath, args: ['--input-type=module', '-e', script] });
    const store = new Store(':memory:');
    const broker = new Broker(store, new Map([['fixture', provider]]), { clients: { caller: { providers: ['fixture'] } } });
    t.after(async () => { await broker.close(); store.close(); });
    await provider.connect();
    const closed = Promise.withResolvers();
    const previous = provider.client.onclose;
    provider.client.onclose = () => { previous?.(); closed.resolve(); };
    const first = await broker.invoke('caller', 'fixture', 'fixture_read', {});
    await closed.promise;
    const second = await broker.invoke('caller', 'fixture', 'fixture_read', {});
    assert.equal(second.kind, 'result');
    assert.notEqual(second.value.content[0].text, first.value.content[0].text, 'A new provider process must serve the second read');
  });

test('the stdio bridge preserves an SSE result when CRLF delimiters straddle network chunks',
  { timeout: 10000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-bridge-review-'));
    const tokenFile = path.join(directory, 'token');
    await writeFile(tokenFile, 'x'.repeat(40), { mode: 0o600 });
    const result = { jsonrpc: '2.0', id: 17, result: { resultType: 'complete', tools: [] } };
    const sent = Promise.withResolvers();
    const http = createServer(async (req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // SSE permits CRLF line endings. Deliberately split each CR/LF pair;
      // a transport must not depend on arbitrary network chunk boundaries.
      res.write(`data: ${JSON.stringify(result)}\r`);
      await delay(10);
      res.write('\n\r');
      await delay(10);
      res.end('\n');
      sent.resolve();
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const child = spawn(process.execPath, [new URL('../bin/client.mjs', import.meta.url).pathname], {
      env: { ...process.env, SWITCHBOARD_URL: `http://127.0.0.1:${http.address().port}/mcp`, SWITCHBOARD_TOKEN_FILE: tokenFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = Promise.withResolvers();
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => {
      stdout += text;
      const line = stdout.split('\n')[0];
      if (stdout.includes('\n')) output.resolve(JSON.parse(line));
    });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.once('error', output.reject);
    t.after(async () => {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('close', resolve));
      }
      http.closeAllConnections();
      await new Promise(resolve => http.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'tools/list', params: {} }) + '\n');
    await sent.promise;
    const actual = await Promise.race([output.promise, delay(200).then(() => ({ noResponse: true, stdout, stderr }))]);
    assert.deepEqual(actual, result);
  });

test('cancelling a stdio subscription stops its HTTP stream and subsequent notifications',
  { timeout: 10000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-cancel-review-'));
    const tokenFile = path.join(directory, 'token');
    await writeFile(tokenFile, 'x'.repeat(40), { mode: 0o600 });
    const handler = createMcpHandler(({ era }) => new Server({ name: 'cancel-fixture', version: '1' }, {
      capabilities: { resources: { subscribe: era === 'modern' } },
    }));
    const nodeHandler = toNodeHandler(handler);
    const cancelled = Promise.withResolvers();
    const http = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      res.once('finish', () => {
        if (body.includes('notifications/cancelled')) cancelled.resolve();
      });
      void nodeHandler(req, res);
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const child = spawn(process.execPath, [new URL('../bin/client.mjs', import.meta.url).pathname], {
      env: { ...process.env, SWITCHBOARD_URL: `http://127.0.0.1:${http.address().port}/mcp`, SWITCHBOARD_TOKEN_FILE: tokenFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const ack = Promise.withResolvers();
    const messages = [];
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const split = buffer.indexOf('\n');
        const message = JSON.parse(buffer.slice(0, split));
        buffer = buffer.slice(split + 1);
        messages.push(message);
        if (message.method === 'notifications/subscriptions/acknowledged') ack.resolve();
      }
    });
    child.once('error', ack.reject);
    t.after(async () => {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('close', resolve));
      }
      await handler.close();
      http.closeAllConnections();
      await new Promise(resolve => http.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    const metadata = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'subscription-1', method: 'subscriptions/listen',
      params: { _meta: metadata, notifications: { resourceSubscriptions: ['fixture://resource'] } } }) + '\n');
    await ack.promise;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled',
      params: { requestId: 'subscription-1', reason: 'fixture finished', _meta: metadata } }) + '\n');
    // Either the bridge consumes cancellation locally or the HTTP receiver
    // finishes its forwarded notification. Allow the former implementation.
    await Promise.race([cancelled.promise, delay(100)]);
    handler.notify.resourceUpdated('fixture://resource');
    await delay(75);
    assert.equal(messages.filter(message => message.method === 'notifications/resources/updated').length, 0);
  });

test('provider credentials remain endpoint scoped and missing exact credentials report auth_required', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-auth-review-'));
  const credentialFile = path.join(directory, 'credentials.json');
  let requests = 0;
  const http = createServer((req, res) => { requests++; req.resume(); res.writeHead(401); res.end(); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${http.address().port}/mcp`;
  await writeFile(credentialFile, JSON.stringify({ other: {
    server_name: 'fixture', server_url: `${url}-another-endpoint`, access_token: 'fixture-secret',
  } }), { mode: 0o600 });
  const provider = new McpProvider('fixture', { url, codexCredential: { file: credentialFile, serverName: 'fixture' } });
  t.after(async () => {
    await provider.close();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(provider.connect());
  assert.equal(requests, 0, 'A credential for another exact endpoint must never be transmitted');
  assert.equal(provider.descriptor.availability, 'auth_required');
});

test('an authenticated provider redirect never forwards credentials to its target', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'switchboard-redirect-review-'));
  const tokenFile = path.join(directory, 'token');
  await writeFile(tokenFile, 'fixture-token-do-not-forward', { mode: 0o600 });
  let targetRequests = 0;
  const target = createServer((req, res) => { targetRequests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const source = createServer((req, res) => {
    req.resume();
    res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/capture` });
    res.end();
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  const provider = new McpProvider('fixture', { url: `http://127.0.0.1:${source.address().port}/mcp`, tokenFile });
  t.after(async () => {
    await provider.close();
    for (const http of [source, target]) {
      http.closeAllConnections();
      await new Promise(resolve => http.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(provider.connect());
  assert.equal(targetRequests, 0);
});
