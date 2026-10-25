import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyChain } from './chain-proof.mjs';

function evidence() {
  const order = ['claude', 'maestro', 'fabric', 'codex'];
  const manifest = { after: 10, startedAt: '2026-10-24T23:59:59Z',
    fixtures: Object.fromEntries(order.map(p => [p, { id: `${p}-fixture`, purpose: 'Switchboard dedicated live E2E' }])),
    expected: Object.fromEntries(order.map(p => [p, `ACK-${p}`])),
  };
  const events = order.map((p, i) => ({ seq: 11 + i, topic: 'session.turn.ended',
    data: { provider: p, sessionId: `${p}-fixture`, turnId: `${p}-turn` }, created_at: '2026-10-25T00:00:00Z' }));
  const follows = order.slice(0, 3).map((p, i) => ({ provider: p, sessionId: `${p}-fixture`,
    notify: { provider: order[i + 1], sessionId: `${order[i + 1]}-fixture` }, state: 'complete',
    deliveriesRequested: 1, maxDeliveries: 1, cursor: 11 + i,
    operation: { status: 'succeeded', createdAt: '2026-10-25T00:00:01Z' },
  }));
  return { manifest, events, follows, transcripts: {
    claude: { sessionId: 'claude-fixture', transcript: JSON.stringify([{ role: 'assistant', text: 'ACK-claude', timestamp: '2026-10-25T00:00:00Z' }]) },
    codex: { sessionId: 'codex-fixture', latestTurn: { turn_id: 'codex-turn', status: 'completed' },
      transcript: JSON.stringify([{ type: 'agentMessage', phase: 'final_answer', text: 'ACK-codex' }]) },
    fabric: { threadId: 'fabric-fixture', items: [{ role: 'assistant', status: 'completed', turnId: 'fabric-turn',
      blocks: [{ blockKind: 'text', textPreview: 'ACK-fabric' }] }] },
  }, maestro: { id: 'maestro-fixture', steps: [{ type: 'assistant_message',
    metadata: { turnId: 'maestro-turn', turnSummary: { state: 'complete' } },
    layout: [{ type: 'text', variant: 'body', content: 'ACK-maestro' }] }] } };
}

test('chain acceptance requires all three dispatches and four native assistant completions', () => {
  assert.equal(verifyChain(evidence()).assistantAcknowledgments, 4);
  for (const mutate of [
    x => x.events.pop(),
    x => { x.follows[1].operation.status = 'outcome_unknown'; },
    x => { x.events[1].data.sessionId = 'unrelated'; },
    x => { x.follows[1].cursor = 10; },
    x => { x.follows[2].deliveriesRequested = 2; },
    x => { x.maestro.steps[0].metadata.turnSummary.state = 'working'; },
  ]) {
    const x = evidence(); mutate(x);
    assert.throws(() => verifyChain(x));
  }
});

test('echoing the expected token in a prompt or another turn cannot pass agent acceptance', () => {
  for (const mutate of [
    x => { x.transcripts.claude.transcript = JSON.stringify([{ role: 'user', text: 'ACK-claude' }]); },
    x => { x.transcripts.codex.transcript = JSON.stringify([{ type: 'userMessage', phase: 'final_answer', text: 'ACK-codex' }]); },
    x => { x.transcripts.fabric.items[0].turnId = 'prior-turn'; },
    x => { x.maestro.steps[0].metadata.turnId = 'prior-turn'; },
    x => { x.transcripts.codex.sessionId = 'unrelated'; },
    x => { x.transcripts.codex.latestTurn.turn_id = 'prior-turn'; },
    x => { x.manifest.startedAt = '2026-10-26T00:00:00Z'; },
  ]) {
    const x = evidence(); mutate(x);
    assert.throws(() => verifyChain(x));
  }
});
