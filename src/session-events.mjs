import { fingerprint, fault } from './store.mjs';
import { randomUUID } from 'node:crypto';

export const sessionEventNames = ['session.turn.started', 'session.turn.ended', 'session.error',
  'session.block.created', 'session.block.updated', 'session.block.completed',
  'session.input_required', 'session.state.changed', 'session.source.gap'];
const descriptions = {
  'session.turn.started': 'The source reports that a turn started.',
  'session.turn.ended': 'The source reports a terminal turn boundary. Inspect outcome; ended does not imply success.',
  'session.error': 'A source-reported error. Its scope distinguishes a tool error from a failed turn.',
  'session.block.created': 'A visible output or tool block started. This is not a completed turn.',
  'session.block.updated': 'An output block changed. High-volume events require an explicit bounded subscription.',
  'session.block.completed': 'A visible output or tool block completed. Tool completion is not turn completion.',
  'session.input_required': 'The source reports an ask or approval request. This event never answers it.',
  'session.state.changed': 'An observed native session state change, without an inferred turn outcome.',
  'session.source.gap': 'Observation was interrupted or replay is incomplete. Reconcile native state before drawing conclusions.',
};
export const sessionEventDefinitions = sessionEventNames.map(name => ({ name, description: descriptions[name], delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { provider: { type: 'string' }, sessionId: { type: 'string' }, turnId: { type: 'string' } },
    required: ['provider', 'sessionId'], additionalProperties: false },
  payloadSchema: { type: 'object', properties: { provider: { type: 'string' }, sessionId: { type: 'string' },
    sourceId: { type: 'string' }, turnId: { type: 'string' }, scope: { type: 'string' }, outcome: { type: 'string' },
    blockId: { type: 'string' }, blockType: { type: 'string' }, state: { type: 'string' }, journalCursor: { type: 'integer' } },
    required: ['provider', 'sessionId', 'sourceId', 'scope', 'journalCursor'], additionalProperties: false } }));
const clean = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null));

// Only explicit source boundaries become turn events. Content, tool failures,
// optimistic task indicators, and transport receipts cannot complete a turn.
export function normalizeSessionEvent(provider, raw, sourceId, state = {}) {
  const out = [], emit = (name, data = {}) => out.push({ name, ...clean({ sourceId, ...data }) });
  if (provider === 'codex') {
    const p = raw.type === 'event_msg' ? raw.payload : null;
    if (!p) return out;
    const turnId = p.turn_id ?? p.root_turn_id;
    if (p.type === 'task_started') emit('session.turn.started', { turnId, scope: 'turn' });
    else if (p.type === 'task_complete') emit('session.turn.ended', { turnId, scope: 'turn', outcome: 'ended' });
    else if (p.type === 'turn_aborted') emit('session.turn.ended', { turnId, scope: 'turn', outcome: 'cancelled' });
    else if (p.type === 'error') emit('session.error', { turnId, scope: 'turn' });
    else if (p.type === 'item_completed' && p.item && !['reasoning', 'encryptedReasoning'].includes(p.item.type)) {
      emit('session.block.completed', { turnId, scope: 'block', blockId: p.item.id, blockType: p.item.type });
      if (p.item.status === 'failed' || p.item.status === 'error') emit('session.error', { turnId, scope: 'block', blockId: p.item.id });
    }
  } else if (provider === 'claude') {
    if (raw.isSidechain) return out;
    if (raw.type === 'user' && (typeof raw.message?.content === 'string'
      || raw.message?.content?.some?.(block => block.type === 'text'))) delete state.finalResponseId;
    if (raw.type === 'assistant') {
      const message = raw.message, block = message?.content?.[0];
      if (message?.id && block && block.type !== 'thinking' && block.type !== 'redacted_thinking') {
        emit('session.block.completed', { scope: 'block', blockId: `${message.id}:${raw.apiBlockIndex ?? raw.uuid}`, blockType: block.type });
      }
      if (message?.stop_reason === 'end_turn' && block?.type === 'text') state.finalResponseId = message.id;
      if (raw.isApiErrorMessage) emit('session.error', { scope: 'inference' });
    } else if (raw.type === 'system' && raw.subtype === 'stop_hook_summary') {
      if (raw.hookErrors?.length) emit('session.error', { scope: 'stop_hook' });
      if (raw.preventedContinuation === true) delete state.finalResponseId;
      if (raw.preventedContinuation === false && state.finalResponseId) {
        emit('session.turn.ended', { scope: 'native_stop_boundary', turnId: state.finalResponseId, outcome: 'ended' });
        delete state.finalResponseId;
      }
    }
  } else if (provider === 'maestro') {
    const p = raw.payload ?? {}, name = raw.name;
    if (name === 'state') {
      emit('session.state.changed', { scope: 'session', state: p.status });
      if (p.status === 'error') emit('session.error', { scope: 'session' });
    } else if (name === 'ask') emit('session.input_required', { scope: 'session' });
    else if (name === 'new_message' || name === 'update_message') {
      const meta = p.metadata ?? {};
      const turnId = meta.turnId ?? meta.turnSummary?.turnId;
      if (p.type === 'assistant_message' && turnId && ['complete', 'stopped', 'cancelled', 'limit', 'error'].includes(meta.turnSummary?.state)) {
        emit('session.turn.ended', { scope: 'persisted_turn_summary', turnId, outcome: meta.turnSummary.reason ?? meta.turnSummary.state ?? 'ended' });
        if (['error', 'failed'].includes(meta.turnSummary.state)) emit('session.error', { scope: 'turn', turnId });
      }
      if (name === 'new_message' && ['assistant_message', 'tool', 'tool_result'].includes(p.type))
        emit('session.block.created', { scope: 'block', blockId: p.id, blockType: p.type });
      if (name === 'update_message' && ['assistant_message', 'tool', 'tool_result'].includes(p.type))
        emit('session.block.updated', { scope: 'block', blockId: p.id, blockType: p.type });
      if (p.type === 'error' || p.name === 'Error') emit('session.error', { scope: 'message', blockId: p.id });
    } else if (/^(error|bridge\.(disconnected|resync_required|authentication_required))$/.test(name))
      emit(name === 'error' ? 'session.error' : 'session.source.gap', { scope: 'source' });
  } else if (provider === 'fabric') {
    const type = raw.eventType ?? raw.type, p = raw.event ?? raw;
    const turnId = p.turnId ?? p.turn?.turnId ?? raw.turnId;
    if (type === 'conversation.turn_started') emit('session.turn.started', { scope: 'turn', turnId });
    if (type === 'conversation.turn_ended') emit('session.turn.ended', { scope: 'turn', turnId, outcome: p.status ?? p.turn?.status ?? 'ended' });
    if (type === 'conversation.turn_ended' && ['failed', 'error'].includes(p.status ?? p.turn?.status))
      emit('session.error', { scope: 'turn', turnId });
    if (['block_started', 'presentation.block_started'].includes(type))
      emit('session.block.created', { scope: 'block', turnId, blockId: p.blockId ?? p.block?.blockId, blockType: p.blockType ?? p.block?.blockKind });
    if (['block_delta', 'presentation.block_delta'].includes(type))
      emit('session.block.updated', { scope: 'block', turnId, blockId: p.blockId ?? p.block?.blockId, blockType: p.blockType ?? p.block?.blockKind });
    if (['block_completed', 'presentation.block_completed'].includes(type))
      emit('session.block.completed', { scope: 'block', turnId, blockId: p.blockId ?? p.block?.blockId, blockType: p.blockType ?? p.block?.blockKind });
    if (['block_failed', 'presentation.block_failed'].includes(type)) emit('session.error', { scope: 'block', turnId, blockId: p.blockId });
    if (['conversation.turn_failed', 'error'].includes(type)) emit('session.error', { scope: 'turn', turnId });
    if (['approval.requested', 'question.created'].includes(type)) emit('session.input_required', { scope: 'session', turnId });
  }
  return out;
}

export class SessionEvents {
  constructor(broker) {
    this.broker = broker; this.db = broker.store.db; this.running = new Map(); this.stopping = new Set(); this.timers = new Map(); this.deliveries = new Map(); this.pendingDeliveries = new Set(); this.closed = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_watches(id TEXT PRIMARY KEY,principal TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_event_ids(principal TEXT NOT NULL,identity TEXT NOT NULL,PRIMARY KEY(principal,identity));
      CREATE TABLE IF NOT EXISTS event_follows(id TEXT PRIMARY KEY,principal TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_follows_principal_state ON event_follows(principal,json_extract(body,'$.state'));`);
  }
  catalog(caller) {
    return sessionEventDefinitions.map(def => ({ ...def, providers: this.broker.principal(caller).providers.map(id => {
      const p = this.broker.provider(caller, id);
      return { provider: id, support: p.descriptor?.availability !== 'ready' ? 'unknown'
        : p.sessionEventTypes?.includes(def.name) ? 'adapted' : 'unsupported', source: p.sessionEventSource ?? null };
    }) }));
  }
  load(id) { const row = this.db.prepare('SELECT body FROM session_watches WHERE id=?').get(id); return row && JSON.parse(row.body); }
  save(w) { this.db.prepare('INSERT OR REPLACE INTO session_watches VALUES(?,?,?)').run(w.id, w.principal, JSON.stringify(w)); }
  head(caller) { return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE principal=?').get(caller).seq); }
  validateWatch(caller, { provider, sessionId, ttlMs }) {
    const p = this.broker.provider(caller, provider);
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 7 * 86400000)
      throw fault('invalid_arguments', 'Watch requires an exact sessionId and ttlMs between 1 second and 7 days.');
    if (!p.watchSession || p.descriptor?.availability === 'ready' && !p.sessionEventTypes?.length)
      throw fault('unsupported', 'This provider has no connected session event source.');
    return p;
  }
  watchView(w) {
    return { watchId: w.id, provider: w.provider, sessionId: w.sessionId, status: w.expiresAt <= Date.now() ? 'expired' : w.status,
      expiresAt: new Date(w.expiresAt).toISOString(), ...(w.cursor !== undefined ? { cursor: w.cursor } : {}), journalCursor: this.head(w.principal) };
  }
  status(caller, id) {
    this.broker.principal(caller);
    const w = this.load(id);
    if (!w || w.principal !== caller) throw fault('not_found', 'Watch not found for this caller.');
    return this.watchView(w);
  }
  current(w) {
    const latest = this.load(w.id);
    return latest?.generation === w.generation ? latest : undefined;
  }
  expire(w) {
    clearTimeout(this.timers.get(w.id));
    const timer = setTimeout(() => {
      const current = this.current(w);
      if (current && current.expiresAt <= Date.now()) void this.removeWatch(current).catch(() => {});
    }, Math.max(0, w.expiresAt - Date.now()));
    timer.unref?.(); this.timers.set(w.id, timer);
  }
  async stopEntry(id, entry) {
    if (!entry) return;
    entry.stopped = true;
    if (this.running.get(id) === entry) this.running.delete(id);
    if (!entry.stopping) {
      entry.stopping = (async () => {
        await entry.ready.catch(() => {});
        if (!entry.closed) { entry.closed = true; await entry.close?.(); }
      })();
      this.stopping.add(entry.stopping);
      entry.stopping.then(() => this.stopping.delete(entry.stopping), () => this.stopping.delete(entry.stopping));
    }
    return entry.stopping;
  }
  async watch(caller, { provider, sessionId, ttlMs = 3600000 }, restoredExpiry) {
    if (this.closed) throw fault('cancelled', 'The event manager is closed.');
    const p = this.validateWatch(caller, { provider, sessionId, ttlMs });
    const id = fingerprint([caller, provider, sessionId]), old = this.load(id);
    if (!old && this.db.prepare('SELECT count(*) AS n FROM session_watches WHERE principal=?').get(caller).n >= 32)
      throw fault('watch_limit', 'At most 32 exact session watches per caller.');
    let entry = this.running.get(id);
    if (entry && ['failed', 'revoked'].includes(old?.status)) {
      await this.stopEntry(id, entry);
      return this.watch(caller, { provider, sessionId, ttlMs }, restoredExpiry);
    }
    const w = { ...old, id, principal: caller, provider, sessionId, expiresAt: Math.max(old?.expiresAt ?? 0, restoredExpiry ?? Date.now() + ttlMs),
      generation: entry?.generation ?? randomUUID(), status: entry ? old.status : 'starting' };
    this.save(w);
    this.expire(w);
    if (!entry) {
      // Own pending setup before the provider can yield or emit any callbacks.
      entry = { generation: w.generation, stopped: false, closed: false };
      this.running.set(id, entry);
      entry.ready = Promise.resolve().then(async () => {
        try {
          entry.close = await p.watchSession(sessionId, { cursor: old?.cursor,
            onEvent: (events, cursor) => this.record(w, events, cursor),
            onError: () => {
              this.record(w, [{ name: 'session.source.gap', sourceId: `source-gap:${randomUUID()}`, scope: 'source' }]);
              const latest = this.current(w);
              if (latest && ['starting', 'watching'].includes(latest.status)) { latest.status = 'failed'; this.save(latest); }
            },
          });
          const latest = this.current(w);
          if (!entry.stopped && !this.closed && latest?.status === 'starting') { latest.status = 'watching'; this.save(latest); }
        } catch (error) {
          const latest = this.current(w);
          if (latest && !entry.stopped) { latest.status = 'failed'; this.save(latest); }
          throw error;
        }
      });
    }
    await entry.ready;
    if (entry.stopped || this.closed || !this.current(w)) throw fault('cancelled', 'Watch setup was cancelled.');
    return this.status(caller, id);
  }
  record(w, events, cursor) {
    if (this.closed) return;
    const current = this.current(w);
    if (!current || !['starting', 'watching'].includes(current.status)) return;
    if (current.expiresAt <= Date.now()) { void this.removeWatch(current).catch(() => {}); return; }
    try { this.broker.provider(w.principal, w.provider); }
    catch {
      current.status = 'revoked'; this.save(current);
      void this.stopEntry(w.id, this.running.get(w.id)).catch(() => {});
      return;
    }
    const seqs = [];
    this.broker.store.transaction(() => {
      for (const event of events) {
        if (!sessionEventNames.includes(event.name) || !event.sourceId) continue;
        const logicalId = event.name === 'session.turn.ended' && event.turnId ? event.turnId
          : ['session.block.created', 'session.block.completed'].includes(event.name) && event.blockId ? event.blockId : event.sourceId;
        const identity = fingerprint([w.provider, w.sessionId, event.name, logicalId]);
        if (!this.db.prepare('INSERT OR IGNORE INTO session_event_ids VALUES(?,?)').run(w.principal, identity).changes) continue;
        const { name, ...data } = event;
        seqs.push(this.broker.store.append(w.principal, name, w.sessionId, { ...clean(data), provider: w.provider, sessionId: w.sessionId }));
      }
      if (cursor !== undefined) { const latest = this.load(w.id); latest.cursor = cursor; this.save(latest); }
    });
    if (seqs.length) this.broker.store.notify(w.principal, w.sessionId);
    void this.deliverFollows(w.principal).catch(() => {});
  }
  async unwatch(caller, id) {
    this.broker.principal(caller);
    const w = this.load(id);
    if (w && w.principal !== caller) throw fault('not_found', 'Watch not found for this caller.');
    if (w) await this.removeWatch(w);
    return { stopped: true };
  }
  async removeWatch(w) {
    if (!this.current(w)) return;
    this.db.prepare('DELETE FROM session_watches WHERE id=? AND principal=?').run(w.id, w.principal);
    clearTimeout(this.timers.get(w.id)); this.timers.delete(w.id);
    await this.stopEntry(w.id, this.running.get(w.id));
  }
  async start() {
    for (const { id } of this.db.prepare('SELECT id FROM session_watches').all()) {
      if (this.closed) return;
      const w = this.load(id);
      if (!w || this.running.has(id)) continue;
      let generation = w.generation;
      if (w.expiresAt <= Date.now()) await this.removeWatch(w);
      else try {
        // Restart preserves expiry; sub-second remnants must still expire even
        // though callers cannot create a watch shorter than one second.
        const setup = this.watch(w.principal, { ...w, ttlMs: Math.max(1000, w.expiresAt - Date.now()) }, w.expiresAt);
        generation = this.load(id)?.generation;
        await setup;
      } catch {
        const latest = this.load(w.id);
        if (latest?.generation === generation) { latest.status = 'failed'; this.save(latest); this.expire(latest); }
      }
    }
    for (const { principal } of this.db.prepare("SELECT DISTINCT principal FROM event_follows WHERE json_extract(body,'$.state')='active'").all())
      void this.deliverFollows(principal).catch(() => {});
  }
  async close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.running.entries()].map(([id, entry]) => this.stopEntry(id, entry)));
    await Promise.allSettled(this.stopping);
    await Promise.allSettled(this.deliveries.values());
  }
  async follow(caller, args, context = {}) {
    if (this.closed) throw fault('cancelled', 'The event manager is closed.');
    const { provider, sessionId, events, notify, requestId, maxDeliveries = 1, ttlMs = 3600000, after, turnId } = args;
    const source = this.validateWatch(caller, { provider, sessionId, ttlMs });
    this.broker.provider(caller, notify?.provider);
    if (!Array.isArray(events) || !events.length || events.length > sessionEventNames.length
      || events.some(name => !sessionEventNames.includes(name)
        || source.descriptor?.availability === 'ready' && !source.sessionEventTypes?.includes(name))
      || typeof notify?.sessionId !== 'string' || !notify.sessionId || notify.sessionId.length > 200
      || turnId !== undefined && (typeof turnId !== 'string' || !turnId || turnId.length > 200)
      || !Number.isSafeInteger(maxDeliveries) || maxDeliveries < 1 || maxDeliveries > 100
      || typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 200)
      throw fault('invalid_arguments', 'Choose supported event types, an exact notification target, a stable requestId and 1-100 deliveries.');
    const head = this.head(caller);
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0 || after > head))
      throw fault('invalid_cursor', 'after must be a nonnegative cursor no later than this caller journal.');
    if (provider === notify.provider && sessionId === notify.sessionId)
      throw fault('notification_cycle', 'A session cannot subscribe to its own follow-up messages.');
    const id = fingerprint([caller, requestId]), digest = fingerprint(args);
    const old = this.db.prepare('SELECT body FROM event_follows WHERE id=? AND principal=?').get(id, caller);
    if (old) {
      const f = JSON.parse(old.body);
      if (f.digest !== digest) throw fault('conflict', 'This requestId already identifies another follow-up subscription.');
      return this.followView(f);
    }
    if (this.db.prepare("SELECT count(*) AS n FROM event_follows WHERE principal=? AND json_extract(body,'$.state')='active' AND json_extract(body,'$.expiresAt')>?").get(caller, Date.now()).n >= 32)
      throw fault('follow_limit', 'At most 32 unexpired active follow-ups per caller. Completed and cancelled retry identities are retained separately.');
    if (!events.every(name => source.sessionEventTypes?.includes(name))) {
      // The manager owns the pending source, including shutdown and concurrent
      // reconnects. Discover its actual event support before creating a follow.
      await this.watch(caller, { provider, sessionId, ttlMs });
      if (events.some(name => !source.sessionEventTypes?.includes(name)))
        throw fault('unsupported', 'The connected provider does not expose the requested event types.');
      // Setup yields. Recheck identity and capacity after another caller request
      // may have registered the same follow while sharing that source setup.
      return this.follow(caller, args, context);
    }
    const f = { id, digest, principal: caller, provider, sessionId, events: [...new Set(events)], notify: { provider: notify.provider, sessionId: notify.sessionId }, turnId,
      context, maxDeliveries, delivered: 0, state: 'active', expiresAt: Date.now() + ttlMs,
      cursor: after ?? head };
    this.saveFollow(f);
    try { await this.watch(caller, { provider, sessionId, ttlMs }); }
    catch (error) { const latest = this.loadFollow(caller, id); if (latest.state === 'active') { latest.state = 'failed'; this.saveFollow(latest); } throw error; }
    void this.deliverFollows(caller).catch(() => {});
    return this.followStatus(caller, id);
  }
  followView(f) { return { followId: f.id, state: f.state, deliveriesRequested: f.delivered,
    maxDeliveries: f.maxDeliveries, expiresAt: new Date(f.expiresAt).toISOString(),
    provider: f.provider, sessionId: f.sessionId, events: f.events, notify: f.notify, cursor: f.cursor,
    ...(f.turnId ? { turnId: f.turnId } : {}),
    matching: f.turnId ? 'exact_native_turn' : 'next_matching_observed_event',
    completionScope: 'notification_dispatch', ...(f.operationId ? { operationId: f.operationId } : {}) }; }
  loadFollow(caller, id) {
    const row = this.db.prepare('SELECT body FROM event_follows WHERE id=? AND principal=?').get(id, caller);
    if (!row) throw fault('not_found', 'Follow-up not found for this caller.');
    return JSON.parse(row.body);
  }
  followStatus(caller, id) {
    this.broker.principal(caller);
    const f = this.loadFollow(caller, id), view = this.followView(f);
    if (f.state === 'active' && f.expiresAt <= Date.now()) view.state = 'expired';
    if (f.operationId) {
      const operation = this.broker.store.get(caller, f.operationId);
      view.operation = { id: operation.id, provider: operation.provider, status: operation.status,
        createdAt: operation.created_at, updatedAt: operation.updated_at };
    }
    return view;
  }
  saveFollow(f) { this.db.prepare('INSERT OR REPLACE INTO event_follows VALUES(?,?,?)').run(f.id, f.principal, JSON.stringify(f)); }
  unfollow(caller, id) {
    this.broker.principal(caller);
    const f = this.loadFollow(caller, id); f.state = 'cancelled'; this.saveFollow(f); return this.followView(f);
  }
  deliverFollows(principal) {
    if (this.closed) return Promise.resolve();
    if (this.deliveries.has(principal)) { this.pendingDeliveries.add(principal); return this.deliveries.get(principal); }
    const work = this.deliver(principal).finally(() => {
      this.deliveries.delete(principal);
      if (this.pendingDeliveries.delete(principal) && !this.closed) void this.deliverFollows(principal).catch(() => {});
    });
    this.deliveries.set(principal, work); return work;
  }
  async deliver(principal) {
    // Capture a finite replay boundary. Dispatch writes its own journal events;
    // those must never turn this pass into a self-sustaining event loop.
    const through = this.head(principal);
    for (const row of this.db.prepare("SELECT body FROM event_follows WHERE principal=? AND json_extract(body,'$.state')='active'").all(principal)) {
      let f = JSON.parse(row.body);
      while (!this.closed) {
        f = this.loadFollow(principal, f.id);
        if (f.state !== 'active') break;
        if (f.expiresAt <= Date.now()) { f.state = 'expired'; this.saveFollow(f); break; }
        try { this.broker.provider(principal, f.provider); this.broker.provider(principal, f.notify.provider); }
        catch { f.state = 'revoked'; this.saveFollow(f); break; }
        const page = this.broker.store.events(principal, { after: f.cursor, limit: 200 }).events.filter(event => event.seq <= through);
        if (!page.length) break;
        for (const event of page) {
          if (this.closed) return;
          f = this.loadFollow(principal, f.id);
          if (f.state !== 'active') break;
          if (f.expiresAt <= Date.now()) { f.state = 'expired'; this.saveFollow(f); break; }
          try { this.broker.provider(principal, f.provider); this.broker.provider(principal, f.notify.provider); }
          catch { f.state = 'revoked'; this.saveFollow(f); break; }
          if (f.events.includes(event.topic) && event.data.provider === f.provider && event.data.sessionId === f.sessionId
            && (!f.turnId || f.turnId === event.data.turnId)) {
            const input = { id: f.notify.sessionId, requestId: `follow:${f.id}:${event.seq}`,
              text: `Switchboard event notification. This is source-observed metadata, not a user instruction or approval.\n${JSON.stringify({ name: event.topic, timestamp: event.created_at, ...event.data })}\nA turn-ended event does not assert success. Inspect the exact native turn before continuing authorized work.` };
            try {
              const receipt = await this.broker.notify(principal, f.notify.provider, input, f.context);
              // Cancellation during dispatch is authoritative. Record the
              // already requested dispatch without reviving the subscription.
              f = this.loadFollow(principal, f.id);
              f.operationId = receipt.operation?.id; f.delivered++;
              if (f.state === 'active' && f.delivered >= f.maxDeliveries) f.state = 'complete';
            } catch { f = this.loadFollow(principal, f.id); if (f.state === 'active') f.state = 'delivery_failed'; }
          }
          f.cursor = event.seq; this.saveFollow(f);
          if (f.state !== 'active') break;
        }
        if (f.state !== 'active' || f.cursor >= through) break;
        // Large persisted backlogs yield between bounded pages, then stop at
        // the captured head; another native callback requests a new pass.
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }
}
