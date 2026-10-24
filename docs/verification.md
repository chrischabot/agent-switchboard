# Verification

This record separates historical live acceptance from local automated tests.
It omits private task names, transcript content, process IDs, and session IDs.

## Current acceptance: October 24, 2026

The running Mac broker connects Codex desktop, Claude Code in Desktop, Fabric
Tutti, and Maestro MCP 0.5.1. Dedicated fixtures isolate all live mutations.
The local automated suite passes 138 tests, including persistence, caller
isolation, crash recovery, task and elicitation contracts, webhook signing,
native event normalization, source replacement, cancellation and replay.

Every originating agent has made actual MCP status calls to every provider:

| Originating agent | Codex | Claude | Fabric | Maestro |
| --- | --- | --- | --- | --- |
| Codex | Pass | Pass | Pass | Pass |
| Claude Code | Pass | Pass | Pass | Pass |
| Fabric | Pass | Pass | Pass | Pass |
| Maestro | Pass | Pass | Pass | Pass |

These cells establish successful passive reads from the named agents. Desktop
status remains a transcript projection and can lag generation. Actual native
tool records support the cells; caller-token harness requests alone do not.

Additional live evidence establishes the following:

- A new Codex fixture discovers and calls the event catalog, then registers an
  exact one-shot turn-end follow-up through MCP.
- The broker observes native Codex turn completion and dispatches one follow-up.
  A notification to Maestro is accepted and appears in its native transcript.
  A notification from a Codex fixture with a different permission mode is held
  by Claude's native peer policy. The policy remains in force.
- Maestro's native metadata watch produces state, block and explicit terminal
  turn events without copying transcript bodies into the hub journal.
- A public HTTPS callback verifies the signed MCP Events challenge and receives
  the real queued, dispatching and succeeded operation events. The test reports
  three distinct event identities and zero invalid requests. This proves
  webhook receipt, not a host's ability to wake a model from that webhook.
- Real MCP exchanges verify hub Tasks creation and result retrieval, preservation
  of a completed result after cancellation acknowledgment, and resource
  invalidation over a modern subscription stream. Maestro's native Tasks also
  complete a watch call. Its cancellation acknowledgment preserves the running
  read until that read actually completes.
- A fresh Codex connection relays a real Maestro elicitation. The client returns
  `decline`; Maestro receives that disposition and leaves its native question
  unanswered. The positive human-acceptance path remains unverified in the app.
- Disposable Maestro session and project fixtures exercise creation, rename or
  update, archive, restore, deletion preview and deletion. Session start, steer,
  stop and resume calls are also exercised. Native receipts and terminal state
  evidence remain distinct; a stop receipt alone does not establish termination.
- The read-only bearer harness passes 41 probes with zero failures or blocked
  probes. It retains 50 unsupported and 320 unrun cells rather than treating
  discovery as full functional acceptance.

Full acceptance remains in progress. The remaining provider lifecycle journeys,
positive human elicitation, host webhook wakeup and the Fabric release require
separate evidence. Fabric's native event-wait tool is implemented and pushed;
its deployment remains subject to the full gateway release gate.

## Live desktop acceptance

On September 11, 2026, the original implementation connected an existing Codex
desktop task and an existing Claude Code 2.1.260 desktop session on macOS. It
started no replacement model processes, restarted neither application, and
changed no recipient permissions or project files.

The following checks passed:

- Discovery of a live owner for the Codex task and a live registered Claude
  Code session.
- Recent conversation reads from both sessions.
- A message from the Codex-side stdio MCP diagnostic client to Claude, followed
  by Claude calling its installed `codex_list`, `claude_list`, `codex_read`, and
  `codex_send` tools. The acknowledgment arrived in the existing Codex task.
- A second exchange after the Claude desktop interface showed the same session
  as idle, with its reply reaching the existing Codex task again.
- A negative sender-context probe that returned a policy hold. Supplying the
  originating Codex task's verified context resolved the missing-metadata
  failure without changing the recipient's approval settings.

These tests used the predecessor MCP name before the Switchboard rename. The
private evidence remains with the original development record and is not part
of this public repository.

## Local tests

The extraction on September 17, 2026, passed seven tests on Node.js 26.8.2.
The suite covers UTF-8 frame lengths, exact-target validation, fragmented IPC
responses, server errors, MCP initialization and tool discovery, private Claude
socket authentication, receipt correlation and cleanup, and sender-context
handling. The MCP handshake test checks the renamed `agent-switchboard`
identity.

Run `npm test` to repeat these checks. They use fixture sessions and sockets;
passing them does not establish compatibility with running applications.

## Historical limitations of the desktop-only implementation

Independent terminal sessions, the Codex idle `start` operation, and Codex's
in-session MCP catalog reload require separate live acceptance. Session
creation, cancellation, a Codex terminal adapter, and durable receipts are not
implemented in that original implementation. The broker now implements durable
receipts and the connected providers' individually declared lifecycle methods.
Ordinary Claude Chat and Cowork conversations remain unsupported.

For a live acceptance check, choose a session whose owner has agreed to the
test, send a unique acknowledgment request, and verify its arrival and reply
in both conversations. Check policy receipts as well as transcript evidence.
Do not infer success from a completed socket write or retry an uncertain write
without checking whether it arrived.
