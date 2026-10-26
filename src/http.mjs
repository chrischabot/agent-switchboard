import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createHubHandler } from './mcp.mjs';

export async function serveHub(broker, { port = 8796, host = '127.0.0.1' } = {}) {
  const clients = new Map();
  for (const [id, config] of Object.entries(broker.config.clients)) {
    const token = (await readFile(config.tokenFile, 'utf8')).trim();
    if (token.length < 32) throw new Error('Client tokens must contain at least 32 characters.');
    clients.set(id, { token: Buffer.from(token), handler: createHubHandler(broker, id) });
  }
  const nodes = new Map([...clients].map(([id, x]) => [id, toNodeHandler(x.handler, { maxRequestBodySize: 1024 * 1024 })]));
  const server = createServer(async (req, res) => {
    const reject = (status, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: message })); };
    // No browser-origin requests or ambient cookies. Remote ingress must retain
    // the bearer token and rewrite Host to this explicitly loopback-bound origin.
    if (req.headers.origin) return reject(403, 'Browser origins are not enabled.');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes((req.headers.host ?? '').replace(/:\d+$/, '')))
      return reject(403, 'Invalid Host.');
    // Webhooks authenticate their signed raw body, not the MCP bearer token.
    if (req.url?.startsWith('/webhooks/') && broker.webhookReceiver)
      return broker.webhookReceiver.handle(req, res);
    const auth = req.headers.authorization?.startsWith('Bearer ') ? Buffer.from(req.headers.authorization.slice(7)) : Buffer.alloc(0);
    let caller;
    for (const [id, client] of clients) if (auth.length === client.token.length && timingSafeEqual(auth, client.token)) caller = id;
    if (!caller) return reject(401, 'A configured client bearer token is required.');
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', version: '0.2.0', agents: await broker.agents(caller) }));
    }
    if (req.url !== '/mcp') return reject(404, 'Not found.');
    try { await nodes.get(caller)(req, res); }
    catch { if (!res.headersSent) reject(500, 'MCP request failed.'); else res.destroy(); }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, port: server.address().port, close: async () => {
    await Promise.all([...clients.values()].map(x => x.handler.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}
