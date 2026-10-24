import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
export const fault = (code, message) => Object.assign(new Error(message), { code });
const now = () => new Date().toISOString();
const decode = row => row ? { ...row, request: JSON.parse(row.request),
  result: row.result === null ? null : JSON.parse(row.result) } : null;

// One broker process owns dispatch. SQL is the authority for retry identities,
// operations and events; native providers remain the authority for agent work.
export class Store extends EventEmitter {
  constructor(filename) {
    super();
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, request_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, provider TEXT NOT NULL, request TEXT NOT NULL,
        status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(principal,request_key));
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, principal TEXT NOT NULL,
        topic TEXT NOT NULL, object_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_principal_seq ON events(principal,seq);
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, operation_id TEXT,
        request TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  append(principal, topic, objectId, data) {
    return Number(this.db.prepare('INSERT INTO events(principal,topic,object_id,data,created_at) VALUES(?,?,?,?,?)')
      .run(principal, topic, objectId, JSON.stringify(data), now()).lastInsertRowid);
  }
  notify(principal, id) { this.emit('change', { principal, id }); }
  submit(principal, key, provider, request) {
    if (typeof key !== 'string' || key.length < 8 || key.length > 200)
      throw fault('invalid_request_id', 'Mutations require a stable requestId of 8–200 characters.');
    const digest = fingerprint({ provider, request });
    const result = this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM operations WHERE principal=? AND request_key=?').get(principal, key);
      if (old) {
        if (old.fingerprint !== digest) throw fault('conflict', 'This requestId already identifies different arguments.');
        return { operation: decode(old), fresh: false };
      }
      const id = randomUUID(), time = now();
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        id, principal, key, digest, provider, JSON.stringify(request), 'queued', null, time, time);
      this.append(principal, 'operation.queued', id, { provider });
      return { operation: this.get(principal, id), fresh: true };
    });
    if (result.fresh) this.notify(principal, result.operation.id);
    return result;
  }
  get(principal, id) {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=? AND principal=?').get(id, principal);
    if (!row) throw fault('not_found', 'Operation not found for this caller.');
    return decode(row);
  }
  list(principal, { after = '', limit = 50 } = {}) {
    return this.db.prepare('SELECT * FROM operations WHERE principal=? AND id>? ORDER BY id LIMIT ?')
      .all(principal, after, Math.min(200, Math.max(1, limit))).map(decode);
  }
  transition(principal, id, from, status, result = null) {
    const changed = this.transaction(() => {
      const current = this.get(principal, id);
      if (!from.includes(current.status)) return false;
      this.db.prepare('UPDATE operations SET status=?,result=?,updated_at=? WHERE id=? AND principal=?')
        .run(status, result === null ? null : JSON.stringify(result), now(), id, principal);
      this.append(principal, `operation.${status}`, id, { status });
      return true;
    });
    if (changed) this.notify(principal, id);
    return changed;
  }
  recover() {
    // A process crash cannot establish whether an upstream accepted its write.
    // Reconcile these operations; only never-dispatched queued work may resume.
    for (const row of this.db.prepare("SELECT * FROM operations WHERE status='dispatching'").all())
      this.transition(row.principal, row.id, ['dispatching'], 'outcome_unknown',
        { code: 'broker_restarted', message: 'Dispatch was interrupted. Inspect the destination before retrying.' });
    return this.db.prepare("SELECT * FROM operations WHERE status='queued' ORDER BY created_at").all().map(decode);
  }
  events(principal, { after = 0, limit = 100 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw fault('invalid_cursor', 'Expected a nonnegative journal cursor.');
    const rows = this.db.prepare('SELECT * FROM events WHERE principal=? AND seq>? ORDER BY seq LIMIT ?')
      .all(principal, after, Math.min(200, Math.max(1, limit)));
    return { events: rows.map(row => ({ ...row, data: JSON.parse(row.data) })),
      nextCursor: rows.at(-1)?.seq ?? after };
  }
  ask(principal, operationId, request) {
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO questions VALUES(?,?,?,?,NULL,?)').run(id, principal, operationId, JSON.stringify(request), now());
      this.append(principal, 'question.created', id, { operationId });
    });
    this.notify(principal, id);
    return id;
  }
  question(principal, id) {
    const row = this.db.prepare('SELECT * FROM questions WHERE id=? AND principal=?').get(id, principal);
    if (!row) throw fault('not_found', 'Question not found for this caller.');
    return { ...row, request: JSON.parse(row.request), response: row.response && JSON.parse(row.response) };
  }
  answer(principal, id, response) {
    this.answerMany(principal, { [id]: response });
  }
  answerMany(principal, responses) {
    const changed = [];
    this.transaction(() => {
      for (const [id, response] of Object.entries(responses)) {
        const old = this.question(principal, id);
        if (old.response && canonical(old.response) !== canonical(response)) throw fault('conflict', 'This question already has a different answer.');
        if (!old.response) {
          this.db.prepare('UPDATE questions SET response=? WHERE id=?').run(JSON.stringify(response), id);
          this.append(principal, 'question.answered', id, { action: response.action });
          changed.push(id, old.operation_id);
        }
      }
    });
    for (const id of new Set(changed.filter(Boolean))) this.notify(principal, id);
  }
  close() { this.removeAllListeners(); this.db.close(); }
}
