#!/usr/bin/env node
// A small Agent Client Protocol agent for tests: JSON-RPC 2.0 over stdio, one
// message per line. Prompt text selects a scripted turn. Every message it
// receives is appended to FAKE_ACP_LOG so tests can assert what the client sent.
import readline from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

const log = entry => { if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify({ pid: process.pid, ...entry }) + '\n'); };
const state = JSON.parse(readFileSync(process.env.FAKE_ACP_STATE, 'utf8'));
const sessions = new Map(state.sessions.map(s => [s.sessionId, s]));
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waiting = new Map(); // outgoing request id -> resolver
const cancels = new Map(); // sessionId -> resolver
let outgoing = 1000, created = 0;

function ask(method, params) {
  const id = ++outgoing;
  send({ id, method, params });
  return new Promise(resolve => waiting.set(id, resolve));
}

async function prompt(id, { sessionId, prompt: blocks }) {
  const text = blocks.map(b => b.text ?? '').join('');
  const cancelled = new Promise(resolve => cancels.set(sessionId, resolve));
  if (text.includes('REJECT')) return send({ id, error: { code: -32602, message: 'Controlled prompt refusal' } });
  if (text.includes('HANG')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working' } });
    await cancelled;
    return send({ id, result: { stopReason: 'cancelled' } });
  }
  if (text.includes('CRASH')) {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'crash-call', title: 'Run a command', kind: 'execute', status: 'in_progress' });
    await pause(text.includes('CRASH_FAST') ? 0 : 150);
    process.exit(3);
  }
  if (text.includes('FS')) {
    const reply = await ask('fs/read_text_file', { sessionId, path: '/etc/hosts' });
    log({ event: 'fs_reply', reply });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (text.includes('PERMISSION')) {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'edit-call', title: 'Write notes.md', kind: 'edit', status: 'pending' });
    const reply = await ask('session/request_permission', { sessionId,
      toolCall: { toolCallId: 'edit-call', title: 'Write notes.md', kind: 'edit', status: 'pending' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
    log({ event: 'permission_reply', reply });
    const allowed = reply.result?.outcome?.outcome === 'selected' && ['allow', 'always'].includes(reply.result.outcome.optionId);
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'edit-call', status: allowed ? 'completed' : 'failed' });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'Wrote notes.md' : 'Permission refused' } });
    return send({ id, result: { stopReason: reply.result?.outcome?.outcome === 'cancelled' ? 'cancelled' : 'end_turn' } });
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning' } });
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'read-call', title: 'Read README.md', kind: 'read', status: 'in_progress' });
  await pause(10);
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'read-call', status: 'completed' });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reviewed: ' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'looks fine.' } });
  await pause(Number(process.env.FAKE_ACP_TURN_MS ?? 30));
  send({ id, result: { stopReason: 'end_turn' } });
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === undefined) { waiting.get(id)?.(message); waiting.delete(id); return; }
  if (method === 'initialize') return send({ id, result: { protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: {}, sessionCapabilities: { resume: {}, close: {}, list: {} } },
    agentInfo: { name: 'Fake ACP Agent', version: '9.9.9' }, authMethods: [] } });
  if (method === 'session/list') return send({ id, result: { sessions: [...sessions.values()].map(({ history, ...s }) => s) } });
  if (method === 'session/new') {
    const sessionId = `new-session-${++created}`;
    sessions.set(sessionId, { sessionId, cwd: params.cwd, title: null, history: [] });
    return send({ id, result: { sessionId } });
  }
  if (['session/load', 'session/resume', 'session/close'].includes(method)) {
    const session = sessions.get(params.sessionId);
    if (!session) return send({ id, error: { code: -32602, message: 'Unknown session' } });
    if (method === 'session/load') for (const value of session.history) update(params.sessionId, value);
    return send({ id, result: {} });
  }
  if (method === 'session/prompt') return prompt(id, params);
  if (method === 'session/cancel') { cancels.get(params.sessionId)?.(); return; }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Method not found' } });
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  log({ event: 'received', message });
  void handle(message);
});
