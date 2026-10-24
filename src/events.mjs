import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fingerprint, fault } from './store.mjs';
import { callbackUrl, secretKey, postWebhook } from './webhooks.mjs';

export const eventDefinition = { name: 'operation.changed', description: 'A durable provider-call receipt changed. The event does not assert agent execution completion.',
  delivery: ['webhook'], inputSchema: { type: 'object', properties: { provider: { type: 'string' }, operationId: { type: 'string' } }, additionalProperties: false },
  payloadSchema: { type: 'object', properties: { operationId: { type: 'string' }, provider: { type: 'string' }, status: { type: 'string' }, journalCursor: { type: 'integer' } },
    required: ['operationId', 'provider', 'status', 'journalCursor'], additionalProperties: false } };

// The journal is the outbox: each subscription advances only after an ACK.
// A crashed sender reuses the same eventId; receivers must deduplicate delivery.
export class Events {
  constructor(broker, { send = postWebhook, now = Date.now } = {}) {
    this.broker = broker; this.db = broker.store.db; this.send = send; this.now = now;
    this.running = new Map(); this.timers = new Map(); this.pending = new Set(); this.closed = false;
    this.db.exec('CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, principal TEXT NOT NULL, body TEXT NOT NULL)');
    this.changed = ({ principal }) => { for (const row of this.db.prepare('SELECT id FROM subscriptions WHERE principal=?').all(principal)) this.kick(row.id); };
    broker.store.on('change', this.changed);
  }
  load(id) { const row = this.db.prepare('SELECT body FROM subscriptions WHERE id=?').get(id); return row && JSON.parse(row.body); }
  save(s) { this.db.prepare('INSERT OR REPLACE INTO subscriptions VALUES(?,?,?)').run(s.id, s.principal, JSON.stringify(s)); }
  identity(caller, params) {
    if (params.name !== eventDefinition.name || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)
      || Object.keys(params.arguments).some(key => !['provider', 'operationId'].includes(key))
      || Object.values(params.arguments).some(value => typeof value !== 'string' || !value || value.length > 200)
      || params.delivery?.mode !== 'webhook') throw fault('invalid_arguments', 'Invalid event subscription.');
    const url = callbackUrl(params.delivery.url).href;
    if (params.arguments.provider) this.broker.provider(caller, params.arguments.provider);
    else this.broker.principal(caller);
    if (params.arguments.operationId) this.broker.store.get(caller, params.arguments.operationId);
    return { id: fingerprint([caller, url, params.name, params.arguments]), url };
  }
  async subscribe(caller, params) {
    const { id, url } = this.identity(caller, params), secret = params.delivery.secret;
    secretKey(secret);
    if (params.ttlMs !== undefined && params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0))
      throw fault('invalid_arguments', 'ttlMs must be a positive integer or null.');
    if (params.cursor !== undefined && params.cursor !== null && !/^\d+$/.test(String(params.cursor))) throw fault('invalid_cursor', 'Expected a journal cursor.');
    const old = this.load(id), now = this.now();
    const requestedCursor = params.cursor == null ? undefined : Number(params.cursor);
    const maxCursor = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE principal=?').get(caller).seq);
    if (requestedCursor !== undefined && (!Number.isSafeInteger(requestedCursor) || requestedCursor > maxCursor)) throw fault('invalid_cursor', 'Cursor is ahead of this journal.');
    const subscription = { id, revision: randomUUID(), principal: caller, url, secret, name: params.name, arguments: params.arguments,
      expiresAt: now + Math.min(params.ttlMs ?? 86400000, 7 * 86400000),
      // A refresh cannot skip an unacknowledged event. An older cursor requests replay.
      cursor: old ? Math.min(old.cursor, requestedCursor ?? old.cursor) : requestedCursor ?? maxCursor,
      attempts: 0, nextAt: now, state: 'active', verifiedAt: old?.verifiedAt ?? 0,
      ...(old?.secret !== secret && old ? { previousSecret: old.secret, rotateUntil: now + 300000 }
        : old?.previousSecret && old.rotateUntil > now ? { previousSecret: old.previousSecret, rotateUntil: old.rotateUntil } : {}),
    };
    if (!old || old.secret !== secret || now - old.verifiedAt > 300000) {
      const challenge = randomUUID();
      let response;
      try { response = await this.send(subscription, `verify_${randomUUID()}`, JSON.stringify({ type: 'verification', challenge })); }
      catch (error) { throw Object.assign(new Error('Callback verification failed.'), { code: -32015, data: { reason: error.name === 'AbortError' ? 'timeout' : 'challenge_failed' } }); }
      let returned; try { returned = JSON.parse(response.body).challenge; } catch {}
      const received = Buffer.from(typeof returned === 'string' ? returned : ''); const expected = Buffer.from(challenge);
      if (response.status < 200 || response.status >= 300 || received.length !== expected.length || !timingSafeEqual(received, expected))
        throw Object.assign(new Error('Callback verification failed.'), { code: -32015, data: { reason: 'challenge_failed' } });
      subscription.verifiedAt = now;
    }
    this.save(subscription); this.kick(id);
    return { id, refreshBefore: new Date(subscription.expiresAt).toISOString(), cursor: String(subscription.cursor), truncated: false };
  }
  unsubscribe(caller, params) {
    const { id } = this.identity(caller, params);
    this.db.prepare('DELETE FROM subscriptions WHERE id=? AND principal=?').run(id, caller);
    clearTimeout(this.timers.get(id)); this.timers.delete(id); return {};
  }
  kick(id) {
    if (this.closed) return;
    if (this.running.has(id)) { this.pending.add(id); return; }
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    const work = this.deliver(id).finally(() => { this.running.delete(id); if (this.pending.delete(id)) this.kick(id); });
    this.running.set(id, work); void work.catch(() => {});
  }
  async deliver(id) {
    for (let count = 0; count < 100 && !this.closed; count++) {
      const s = this.load(id);
      if (!s || s.state !== 'active' || s.expiresAt <= this.now()) return;
      if (s.nextAt > this.now()) { this.schedule(id, s.nextAt - this.now()); return; }
      let grants; try { grants = this.broker.principal(s.principal).providers; } catch { s.state = 'revoked'; this.save(s); return; }
      if (s.arguments.provider && !grants.includes(s.arguments.provider)) { s.state = 'revoked'; this.save(s); return; }
      const e = this.db.prepare("SELECT e.*,o.provider FROM events e JOIN operations o ON o.id=e.object_id AND o.principal=e.principal WHERE e.principal=? AND e.seq>? AND e.topic LIKE 'operation.%' ORDER BY e.seq LIMIT 1").get(s.principal, s.cursor);
      if (!e) return;
      if (!grants.includes(e.provider) || (s.arguments.provider && s.arguments.provider !== e.provider) || (s.arguments.operationId && s.arguments.operationId !== e.object_id)) {
        s.cursor = e.seq; this.save(s); continue;
      }
      const event = { eventId: `switchboard_${e.seq}`, name: s.name, timestamp: e.created_at,
        data: { operationId: e.object_id, provider: e.provider, status: e.topic.slice('operation.'.length), journalCursor: e.seq }, cursor: String(e.seq) };
      let response; try { response = await this.send(s, event.eventId, JSON.stringify(event)); } catch { response = { status: 0 }; }
      // An unsubscribe or refresh while HTTPS was in flight must not be undone.
      const latest = this.load(id);
      if (!latest || latest.revision !== s.revision) return;
      if (response.status >= 200 && response.status < 300) { s.cursor = e.seq; s.attempts = 0; s.nextAt = this.now(); this.save(s); continue; }
      s.attempts++;
      if ([410, 413].includes(response.status) || (response.status >= 400 && response.status < 500 && response.status !== 429) || s.attempts >= 5) s.state = 'failed';
      else { s.nextAt = this.now() + Math.min(60000, 1000 * 2 ** (s.attempts - 1)); this.schedule(id, s.nextAt - this.now()); }
      this.save(s); return;
    }
    this.schedule(id, 0);
  }
  schedule(id, delay) { if (this.closed) return; clearTimeout(this.timers.get(id)); const timer = setTimeout(() => this.kick(id), delay); timer.unref?.(); this.timers.set(id, timer); }
  start() { for (const row of this.db.prepare('SELECT id FROM subscriptions').all()) this.kick(row.id); }
  async close() { this.closed = true; this.broker.store.off('change', this.changed); for (const timer of this.timers.values()) clearTimeout(timer); await Promise.allSettled(this.running.values()); }
}
