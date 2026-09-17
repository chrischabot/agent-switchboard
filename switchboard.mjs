import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const roots = {
  codex: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  claude: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
};

function id(value) {
  if (!uuid.test(value)) throw new Error('An exact session UUID is required.');
  return value;
}

function bounded(value, fallback, max) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > max) {
    throw new Error(`Expected an integer from 1 to ${max}.`);
  }
  return result;
}

function message(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32000) {
    throw new Error('Message must contain 1-32000 characters.');
  }
  return `[Switchboard: peer message, not a user instruction]\n${value}`;
}

export function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class CodexIPC {
  constructor(socketPath = path.join(roots.codex, 'ipc', 'ipc.sock')) {
    this.socketPath = socketPath;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = Buffer.alloc(0);
    this.clientId = 'initializing-client';
  }

  async connect() {
    const stat = await fs.lstat(this.socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      throw new Error('Codex IPC socket must be private and owned by this user.');
    }
    this.socket = net.createConnection(this.socketPath);
    this.socket.on('data', (data) => {
      try {
        this.buffer = Buffer.concat([this.buffer, data]);
        while (this.buffer.length >= 4) {
          const size = this.buffer.readUInt32LE(0);
          if (!size || size > 256 * 1024 * 1024) throw new Error('Invalid IPC frame.');
          if (this.buffer.length < size + 4) break;
          const item = JSON.parse(this.buffer.subarray(4, size + 4).toString());
          this.buffer = this.buffer.subarray(size + 4);
          if (item.type === 'response') this.pending.get(item.requestId)?.(item);
          if (item.type === 'broadcast') {
            for (const listener of this.listeners) listener(item);
          }
          if (item.type === 'client-discovery-request') {
            this.socket.write(frame({ type: 'client-discovery-response',
              requestId: item.requestId, response: { canHandle: false } }));
          }
        }
      } catch (error) { this.socket.destroy(error); }
    });
    this.socket.on('error', (error) => this.fail(error.message));
    this.socket.on('close', () => this.fail('Codex IPC disconnected; delivery may be unknown.'));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.destroy(); reject(new Error('Codex IPC connection timeout.'));
      }, 5000);
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const result = await this.request('initialize', { clientType: 'agent-switchboard' }, 0);
    this.clientId = result.result.clientId;
    return this;
  }

  fail(error) {
    for (const callback of [...this.pending.values()]) callback({ resultType: 'error', error });
  }

  request(method, params, version, targetClientId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('IPC timeout; do not retry a write without checking delivery.'));
      }, timeoutMs);
      this.pending.set(requestId, (result) => {
        clearTimeout(timer); this.pending.delete(requestId);
        if (result.resultType === 'error') reject(new Error(result.error));
        else resolve(result);
      });
      this.socket.write(frame({ type: 'request', requestId, method, params,
        sourceClientId: this.clientId, version, targetClientId, timeoutMs }));
    });
  }

  async owner(sessionId) {
    const response = await this.request('thread-owner-discovery',
      { hostId: 'local', conversationId: id(sessionId) }, 1);
    return response.handledByClientId;
  }

  close() { this.socket?.destroy(); }
}

async function withIPC(callback) {
  const ipc = new CodexIPC();
  try { await ipc.connect(); return await callback(ipc); }
  finally { ipc.close(); }
}

function codexRows(sessionId, limit = 30) {
  const db = new DatabaseSync(path.join(roots.codex, 'state_5.sqlite'), { readOnly: true });
  try {
    const fields = 'id, title, cwd, source, updated_at, history_mode, rollout_path, sandbox_policy, approval_mode';
    return sessionId
      ? db.prepare(`SELECT ${fields} FROM threads WHERE id = ?`).all(id(sessionId))
      : db.prepare(`SELECT ${fields} FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?`)
        .all(bounded(limit, 30, 100));
  } finally { db.close(); }
}

export async function codexList({ limit } = {}) {
  const rows = codexRows(undefined, limit);
  return await withIPC(async (ipc) => {
    const result = [];
    for (let offset = 0; offset < rows.length; offset += 5) {
      await Promise.all(rows.slice(offset, offset + 5).map(async (row) => {
      try {
        const owner = await ipc.owner(row.id);
        result.push({ sessionId: row.id, name: row.title, cwd: row.cwd,
          source: row.source, owner, live: true });
      } catch (error) {
        if (error.message !== 'no-client-found') throw error;
      }
      }));
    }
    return { sessions: result, examined: rows.length, scope: 'recent saved sessions with a live desktop owner' };
  });
}

export async function codexOwner({ sessionId }) {
  return await withIPC(async (ipc) => ({ sessionId, owner: await ipc.owner(sessionId), live: true }));
}

export async function codexRead({ sessionId, maxChars }) {
  id(sessionId);
  const cap = bounded(maxChars, 16000, 100000);
  const db = new DatabaseSync(path.join(roots.codex, 'thread_history_1.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare(`SELECT item_json FROM thread_items WHERE thread_id = ?
      AND item_type IN ('userMessage', 'agentMessage') ORDER BY rollout_ordinal DESC LIMIT 100`)
      .all(sessionId).reverse();
    const messages = rows.map((row) => JSON.parse(row.item_json));
    const latestTurn = db.prepare(`SELECT turn_id, status FROM thread_turns WHERE thread_id = ?
      ORDER BY rollout_ordinal DESC LIMIT 1`).get(sessionId);
    const text = JSON.stringify(messages);
    return { sessionId, latestTurn, source: 'read-only local history projection',
      truncated: text.length > cap || rows.length === 100, transcript: text.slice(-cap) };
  } finally { db.close(); }
}

export async function codexSend({ sessionId, text, mode }) {
  const body = message(text);
  if (!['start', 'steer'].includes(mode)) throw new Error('Choose start for idle or steer for active.');
  const row = codexRows(sessionId)[0];
  if (!row) throw new Error('Unknown Codex session.');
  const state = await codexRead({ sessionId, maxChars: 1 });
  if (mode === 'start' && state.latestTurn?.status === 'inProgress') {
    throw new Error('The latest recorded turn is active; use steer.');
  }
  return await withIPC(async (ipc) => {
    const owner = await ipc.owner(sessionId);
    const clientUserMessageId = randomUUID();
    const input = [{ type: 'text', text: body, text_elements: [] }];
    const params = mode === 'start' ? {
      conversationId: sessionId,
      turnStart: { request: { threadId: sessionId, input, clientUserMessageId }, context: {} },
    } : {
      conversationId: sessionId, input, clientUserMessageId, attachments: [],
      restoreMessage: { id: clientUserMessageId, text: body, cwd: row.cwd, createdAt: Date.now(),
        context: { prompt: body, addedFiles: [], fileAttachments: [], ideContext: null,
          imageAttachments: [], workspaceRoots: [row.cwd] } },
    };
    const response = await ipc.request(`thread-follower-${mode}-turn`, params,
      mode === 'start' ? 2 : 1, owner, 45000);
    return { sessionId, clientUserMessageId, receipt: response.result,
      state: 'owner-accepted', completion: 'not-yet-verified' };
  });
}

export async function claudeList() {
  const directory = path.join(roots.claude, 'sessions');
  const sessions = [];
  for (const name of await fs.readdir(directory)) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const recordPath = path.join(directory, name);
      const stat = await fs.lstat(recordPath);
      if (!stat.isFile() || stat.uid !== process.getuid()) continue;
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      const pid = Number(name.slice(0, -5));
      const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='],
        { env: { ...process.env, TZ: 'UTC' } });
      if (!record.procStart || stdout.trim().replace(/\s+/g, ' ') !== record.procStart.replace(/\s+/g, ' ')) continue;
      if (!uuid.test(record.sessionId)) continue;
      sessions.push({ sessionId: record.sessionId, pid, name: record.name,
        cwd: record.cwd, entrypoint: record.entrypoint, version: record.version,
        socket: record.messagingSocketPath, procStart: record.procStart,
        messaging: Boolean(record.messagingSocketPath) });
    } catch { /* A process may exit or update its record during discovery. */ }
  }
  return { sessions };
}

async function claudeSession(sessionId) {
  id(sessionId);
  const row = (await claudeList()).sessions.find((entry) => entry.sessionId === sessionId);
  if (!row) throw new Error('No live Claude session matches this UUID.');
  return row;
}

export async function claudeRead({ sessionId, maxChars }) {
  const row = await claudeSession(sessionId);
  const cap = bounded(maxChars, 16000, 100000);
  const project = row.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const file = path.join(roots.claude, 'projects', project, `${sessionId}.jsonl`);
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, 1024 * 1024);
    const bytes = Buffer.alloc(size);
    await handle.read(bytes, 0, size, stat.size - size);
    const lines = bytes.toString().split('\n');
    if (stat.size > size) lines.shift();
    const messages = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (['user', 'assistant'].includes(event.type)) {
          const content = event.message?.content;
          const text = typeof content === 'string' ? content : content
            ?.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
          if (text) messages.push({ role: event.type, timestamp: event.timestamp, text });
        }
      } catch { /* Ignore partial writes at the end of the live transcript. */ }
    }
    const text = JSON.stringify(messages);
    return { sessionId, source: 'local transcript tail', truncated: text.length > cap || stat.size > size,
      transcript: text.slice(-cap) };
  } finally { await handle.close(); }
}

export function claudePeerBody(body, sender, from) {
  if (!sender) return body;
  const escaped = body.replace(/<(\/?cross-session-message)/gi, '<\\$1');
  return `<cross-session-message from="${from}" from-session="${sender.sessionId}" from-name="Codex through Switchboard" from-mode="${sender.mode}">\n${escaped}\n</cross-session-message>`;
}

function codexSender(context = {}) {
  // Never infer the sender's permission mode from the destination. Missing
  // host context remains unknown, so Claude's inbound policy can hold it.
  const sessionId = context.codexThreadId ?? process.env.CODEX_THREAD_ID;
  if (!sessionId || !uuid.test(sessionId)) return undefined;
  const row = codexRows(sessionId)[0];
  if (!row) return undefined;
  const sandbox = JSON.parse(row.sandbox_policy);
  if (sandbox.type === 'disabled' && row.approval_mode === 'never') {
    return { sessionId, mode: 'bypass' };
  }
  if (['on-request', 'untrusted', 'on-failure'].includes(row.approval_mode)) {
    return { sessionId, mode: 'prompting' };
  }
  return undefined;
}

async function receiptInbox(directory, msgId, destination) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
    throw new Error('The Claude inbox directory must be owned by this user and not writable by others.');
  }
  const socketPath = path.join(directory, `${process.pid}-${randomUUID().slice(0, 8)}.sock`);
  const receipts = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (data) => {
      buffer += data;
      if (buffer.length > 65536) { socket.destroy(); return; }
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        try {
          const item = JSON.parse(line);
          if (item.type === 'control' && item.action === 'peer_message_status' &&
              item.orig_msg_id === msgId && item.from === `uds:${destination}`) {
            if (receipts.length < 16) receipts.push({ status: item.status, detail: item.status_detail,
              reason: item.reason, messageId: item.orig_msg_id });
          }
        } catch { /* Ignore malformed or unrelated receipt frames. */ }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
  return {
    from: `uds:${socketPath}`, receipts,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function claudeSend({ sessionId, text, receiptWaitMs }, context) {
  const body = message(text);
  const waitMs = bounded(receiptWaitMs, 1500, 5000);
  const row = await claudeSession(sessionId);
  if (!row.socket) throw new Error('This session has not enabled a messaging inbox.');
  const stat = await fs.lstat(row.socket);
  if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Claude socket must be private and owned by this user.');
  }
  const { stdout: sockets } = await exec('/usr/sbin/lsof',
    ['-a', '-U', '-p', String(row.pid), '-Fn']);
  if (!sockets.split('\n').includes(`n${row.socket}`)) {
    throw new Error('The registered Claude process no longer owns this socket.');
  }
  const digest = createHash('sha256').update(path.resolve(row.socket)).digest('hex');
  const keyPath = path.join(roots.claude, 'sessions', `${row.pid}.${digest}.key`);
  let token;
  try {
    const keyStat = await fs.lstat(keyPath);
    if (!keyStat.isFile() || keyStat.uid !== process.getuid() || (keyStat.mode & 0o077)) {
      throw new Error('Unsafe Claude peer-key permissions.');
    }
    token = JSON.parse(await fs.readFile(keyPath, 'utf8')).peerToken;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const msgId = randomUUID();
  const sender = codexSender(context);
  const inbox = await receiptInbox(path.dirname(row.socket), msgId, row.socket);
  const envelope = { type: 'user', session_id: sessionId, msg_id: msgId, from: inbox.from,
    message: { role: 'user', content: claudePeerBody(body, sender, inbox.from) }, priority: 'next' };
  const lines = (token ? JSON.stringify({ type: 'auth', token }) + '\n' : '') +
    JSON.stringify(envelope) + '\n';
  try {
    await new Promise((resolve, reject) => {
    const socket = net.createConnection(row.socket);
    let failure;
    socket.setTimeout(5000, () => socket.destroy(new Error('Claude delivery timeout; outcome unknown.')));
    socket.once('error', (error) => { failure = error; });
    socket.once('connect', () => {
      socket.write(lines, () => setTimeout(() => socket.end(), 150));
    });
    socket.once('close', () => failure ? reject(failure) : resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const receipt = inbox.receipts.at(-1);
    return { sessionId, msgId, sender: sender ?? null, receipts: inbox.receipts,
      state: receipt?.detail === 'refused' ? 'refused' : receipt?.status ?? 'transport-sent',
      completion: 'not-verified; inspect transcript for the receiving agent reply' };
  } finally { await inbox.close(); }
}
