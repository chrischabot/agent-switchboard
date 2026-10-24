import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DesktopProvider } from '../src/providers.mjs';
import { roots, frame } from '../switchboard.mjs';

test('reachable Codex stays ready when recent saved threads have no desktop owner', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-discovery-'));
  const previous = roots.codex;
  roots.codex = directory;
  await fs.mkdir(path.join(directory, 'ipc'));
  const db = new DatabaseSync(path.join(directory, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, source TEXT, updated_at INTEGER,
    history_mode TEXT, rollout_path TEXT, sandbox_policy TEXT, approval_mode TEXT, archived INTEGER);
    INSERT INTO threads VALUES('00000000-0000-4000-8000-000000000001','recent CLI task','/tmp','cli',1,'','','','',0);`);
  db.close();
  const socketPath = path.join(directory, 'ipc/ipc.sock');
  const server = net.createServer(socket => {
    let data = Buffer.alloc(0);
    socket.on('data', bytes => {
      data = Buffer.concat([data, bytes]);
      while (data.length >= 4 && data.length >= data.readUInt32LE(0) + 4) {
        const n = data.readUInt32LE(0), request = JSON.parse(data.subarray(4, n + 4));
        data = data.subarray(n + 4);
        socket.write(frame({ type: 'response', requestId: request.requestId,
          ...(request.method === 'initialize' ? { resultType: 'success', result: { clientId: 'test' } }
            : { resultType: 'error', error: 'no-client-found' }) }));
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  await fs.chmod(socketPath, 0o600);
  try {
    const provider = new DesktopProvider('codex');
    assert.deepEqual((await provider.connect()).sessions, []);
    assert.equal(provider.descriptor.availability, 'ready');
    assert.deepEqual(provider.descriptor.discovery, { examined: 1, found: 0, complete: false });
  } finally {
    roots.codex = previous;
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true });
  }
});
