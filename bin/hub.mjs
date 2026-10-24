#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { readFile, mkdir } from 'node:fs/promises';
import { Store } from '../src/store.mjs';
import { loadProviders } from '../src/providers.mjs';
import { Broker } from '../src/broker.mjs';
import { serveHub } from '../src/http.mjs';
import { Events } from '../src/events.mjs';
import { SessionEvents } from '../src/session-events.mjs';

const configPath = process.env.SWITCHBOARD_CONFIG ?? path.join(os.homedir(), '.local/state/agent-switchboard/config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
const store = new Store(path.join(config.stateDir, 'broker.sqlite'));
const providers = await loadProviders(config);
const broker = new Broker(store, providers, config);
broker.sessionEvents = new SessionEvents(broker);
broker.events = new Events(broker);
// Binding the unique local address precedes recovery, so a second invocation
// cannot reclassify a live broker's in-flight work as interrupted.
const http = await serveHub(broker, { port: config.port });
process.stderr.write(`Switchboard listening on http://127.0.0.1:${http.port}/mcp\n`);
await Promise.allSettled([...providers].map(async ([id, p]) => {
  try { await p.connect(); process.stderr.write(`${id}: ${p.descriptor.availability}; ${p.catalog.length} tools\n`); }
  catch (error) { process.stderr.write(`${id}: ${p.descriptor.availability}; connection failed (${error.code ?? 'transport'})\n`); }
}));
broker.recover();
broker.events.start();
await broker.sessionEvents.start();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await http.close(); await broker.events.close(); await broker.sessionEvents.close(); await broker.close(); store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
