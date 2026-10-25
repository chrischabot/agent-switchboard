#!/usr/bin/env node
// Reconcile a recorded four-provider chain. Never send a message or replay a
// notification to manufacture missing evidence.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { toolValue } from '../../src/providers.mjs';
import { connectOperator } from '../../bin/call.mjs';

function unwrap(raw) {
  for (let i = 0; i < 12; i++) {
    assert.ok(!raw?.isError && !raw?.error, 'Native read failed.');
    const next = toolValue(raw);
    if (next !== raw) raw = next;
    else if (raw?.kind === 'result') raw = raw.value;
    else return raw;
  }
  throw new Error('Invalid response envelope.');
}

export function verifyChain({ manifest, events, follows, transcripts, maestro }) {
  const order = ['claude', 'maestro', 'fabric', 'codex'];
  for (const provider of order) {
    assert.equal(manifest.fixtures[provider]?.purpose, 'Switchboard dedicated live E2E');
    assert.ok(typeof manifest.expected[provider] === 'string' && manifest.expected[provider].length);
  }
  assert.equal(follows.length, 3);
  let previous = manifest.after;
  const ends = [];
  for (let i = 0; i < 3; i++) {
    const f = follows[i], source = order[i], destination = order[i + 1];
    assert.equal(f.provider, source);
    assert.equal(f.sessionId, manifest.fixtures[source].id);
    assert.equal(f.notify.provider, destination);
    assert.equal(f.notify.sessionId, manifest.fixtures[destination].id);
    assert.equal(f.state, 'complete');
    assert.equal(f.maxDeliveries, 1);
    assert.equal(f.deliveriesRequested, 1);
    assert.equal(f.operation?.status, 'succeeded', 'A completed follow is only a dispatch attempt.');
    const event = events.find(e => e.seq === f.cursor && e.topic === 'session.turn.ended'
      && e.data.provider === source && e.data.sessionId === f.sessionId);
    assert.ok(event && event.seq > previous, 'Source completion must follow the preceding hop.');
    assert.ok(Date.parse(f.operation.createdAt) >= Date.parse(event.created_at));
    ends.push(event); previous = event.seq;
  }
  const final = events.find(e => e.seq > previous && e.topic === 'session.turn.ended'
    && e.data.provider === 'codex' && e.data.sessionId === manifest.fixtures.codex.id);
  assert.ok(final, 'Final Codex execution has no observed terminal boundary.');
  ends.push(final);
  const claude = unwrap(transcripts.claude), codex = unwrap(transcripts.codex), fabric = unwrap(transcripts.fabric);
  assert.equal(claude.sessionId, manifest.fixtures.claude.id);
  assert.equal(codex.sessionId, manifest.fixtures.codex.id);
  assert.equal(fabric.threadId, manifest.fixtures.fabric.id);
  assert.equal(maestro.id, manifest.fixtures.maestro.id);
  assert.ok(JSON.parse(claude.transcript).some(m => m.role === 'assistant' && m.text === manifest.expected.claude
    && Date.parse(m.timestamp) >= Date.parse(manifest.startedAt)
    && Date.parse(m.timestamp) <= Date.parse(ends[0].created_at)), 'Claude assistant acknowledgment missing.');
  assert.equal(codex.latestTurn?.turn_id, final.data.turnId);
  assert.equal(codex.latestTurn.status, 'completed');
  assert.equal(JSON.parse(codex.transcript).filter(m => m.type === 'agentMessage' && m.phase === 'final_answer').at(-1)?.text,
    manifest.expected.codex, 'Codex final acknowledgment missing.');
  assert.ok(fabric.items.some(m => m.role === 'assistant' && m.turnId === ends[2].data.turnId
    && m.status === 'completed' && m.blocks.some(b => b.blockKind === 'text' && b.textPreview === manifest.expected.fabric)), 'Fabric assistant acknowledgment missing.');
  assert.ok(maestro.steps.some(m => m.type === 'assistant_message' && m.metadata?.turnId === ends[1].data.turnId
    && m.metadata.turnSummary?.state === 'complete'
    && m.layout?.some(b => b.type === 'text' && b.variant === 'body' && b.content === manifest.expected.maestro)), 'Maestro completed assistant acknowledgment missing.');
  return { status: 'live_pass', automaticNotifications: 3, nativeTerminalBoundaries: 4,
    assistantAcknowledgments: 4, sequence: order,
    scope: 'Recorded native agent execution and one-shot dispatch, not webhook host wakeup.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const prefix = process.argv[2];
  assert.match(prefix ?? '', /^[a-zA-Z0-9_-]{8,100}$/);
  const directory = new URL('../../evidence/live/', import.meta.url);
  const read = async suffix => JSON.parse(await readFile(new URL(`${prefix}${suffix}.json`, directory), 'utf8'));
  const manifest = await read('');
  const rpc = await connectOperator();
  const follows = [];
  for (const f of manifest.follows) follows.push(unwrap(await rpc('tools/call', {
    name: 'events_follow_status', arguments: { followId: f.followId },
  })));
  const events = (await read('-events')).events;
  const transcripts = { claude: await read('-claude-read'), codex: await read('-codex-read'), fabric: await read('-fabric-read') };
  const maestro = await read('-maestro-native');
  const evidence = { manifest, events, follows, transcripts, maestro };
  const report = { ...verifyChain(evidence), verifiedAt: new Date().toISOString(),
    evidenceSha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') };
  await writeFile(new URL(`${prefix}-proof.json`, directory), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
