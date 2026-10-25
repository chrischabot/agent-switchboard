# Verification

This record separates historical live acceptance from local automated tests.
It omits private task names, transcript content, process IDs, and session IDs.

## Current acceptance: October 25, 2026

The running Mac broker connects Codex desktop, Claude Code in Desktop, Fabric
Tutti, and Maestro MCP 0.5.2. Dedicated fixtures isolate all live mutations.
The local automated suite passes 142 tests, including persistence, caller
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

- The coordinated Fabric release train deploys the protocol changes. Gateway
  `051e64b7` includes reviewed Switchboard commit `29e561b4`; Cadence is
  `0.2.624@a4c6c4a1`. Native Tasks, bounded thread listing, event waits,
  task-resource reads and completed-task cancellation pass against that runtime.
- A real Codex prompt reaches Claude, whose native turn end triggers Maestro,
  whose native turn end triggers Fabric, whose native turn end triggers Codex.
  All three automatic notifications dispatch once. Four native terminal
  boundaries and four exact assistant acknowledgments establish execution.
  The read-only chain verifier rejects uncertain receipts, unrelated sessions,
  prior-turn evidence, and tokens appearing only in user prompts.
- A new Codex fixture discovers and calls the event catalog, then registers an
  exact one-shot turn-end follow-up through MCP.
- The broker observes native Codex turn completion and dispatches one follow-up.
  A notification to Maestro is accepted and appears in its native transcript.
  A notification from a Codex fixture with a different permission mode is held
  by Claude's native peer policy. The policy remains in force.
- A direct prompt in the owned Claude fixture produces the expected reply,
  a completed text-block event and the native stop-hook turn-end event. This
  establishes event observation separately from peer-message permission checks.
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
  unanswered. A repeat against Maestro's current single-text question flow
  exposes and fixes its native-form mapping. The live form then reaches Codex,
  which again returns `decline` immediately. This does not establish a human
  click or a positive human-acceptance path in the app.
- Disposable Maestro session and project fixtures exercise creation, rename or
  update, archive, restore, deletion preview and deletion. Session start, steer,
  stop and resume calls are also exercised. Native receipts and terminal state
  evidence remain distinct; a stop receipt alone does not establish termination.
- Disposable Fabric fixtures exercise project and session creation, brief update,
  session archive and restore, guarded steering and stop, and same-thread
  resume. The stopped native turn becomes `cancelled` with an idle runtime;
  the resumed turn completes with the expected acknowledgment.
- The disposable Fabric project reaches `archived`, restores to `paused`
  without resuming work, then accepts deletion through its native lifecycle
  API and fresh impact token. The disposable session enters its native
  ten-minute deletion undo window. Legacy resource deletion is rejected for
  coordinated projects and is no longer the normalized binding.
- A dedicated Codex fixture exercises guarded interruption and subsequent
  same-thread messaging. Native history confirms an interrupted turn followed
  by a completed continuation with the expected acknowledgment. This does not
  declare a separate Codex `resume` or session-creation adapter capability.
- An existing Codex fixture accepts active-turn steering and completes with the
  expected acknowledgment. A deliberate failed command produces a block-scoped
  error; the same turn later ends normally. Incoming user messages and reasoning
  items are excluded from output-block subscriptions.
- Separate one-shot subscriptions deliver a real Codex block error and a
  completed output block to Fabric. Both dispatch once; Fabric's corresponding
  native turns complete and acknowledge the event type. The error does not
  falsely end the Codex turn. Test watches are stopped after evidence capture.
- Maestro's native status is `stopped` after cleanup of the elicitation fixture.
  The client disposition and unanswered question are retained in the evidence;
  no agent supplies a human answer.
- The read-only bearer harness passes 46 probes with zero failures or blocked
  probes. It retains 42 unsupported and 325 unrun cells rather than treating
  discovery as full functional acceptance.

Fabric deployment and the four-agent notification chain are verified.
The October 25 follow-up also verifies a signed public webhook causing an
existing local Codex session to run, as described below. Positive human
elicitation remains pending a human submission. Unsupported desktop lifecycle
methods remain explicitly unsupported.

The normalized lifecycle coverage is summarized in [the acceptance matrix](acceptance-matrix.md).
The bearer harness deliberately keeps mutation and originating-agent cells
unrun in its read-only report; separate lifecycle receipts, native transcripts,
protocol proofs and chain evidence establish those journeys. The native-tool
catalog includes unrelated provider administration tools that have not all
been exercised. Discovery is not a claim of exhaustive native-provider testing.

## October 25 webhook wakeup and human-form follow-up

The new durable receiver passes the full live path: a native Fabric turn ends,
the outbox sends its signed event through public HTTPS, the receiver verifies
and persists it, native Codex IPC starts a turn, and Codex's persisted final
assistant output acknowledges that exact event ID. Replaying the same signed
event returns the original operation ID and creates no second dispatch.
The callback's signed verification challenge also passes. The temporary
subscription and watch are removed afterward. This is Switchboard's local
receiver adapter, not a claim that local Codex implements Work Cloud callbacks.

`test/live/webhook-wakeup-proof.mjs` checks source/target fixture identities,
subscription verification, inbox and dispatch receipts, native terminal state,
the assistant acknowledgment, and signed replay. Private evidence remains in
`evidence/live/`. The automated suite passes 146 tests, including receiver
signature/source rejection, durable deduplication, crash-window recovery and
retention of dispatch failures. Syntax checks cover 19 source files.

The local Codex source explains the earlier immediate decline: `Never`
approval policy rejects elicitation unless the full-access form-input exception
is available. After the owner switches the chat to Default permissions, the
same MCP relay displays a native Codex form with an editable answer field and
Accept/Deny controls, observed directly in the app accessibility tree. Two
presentations time out without a submitted response; the operation stays
`waiting_input` and the native question stays open. A positive human answer is
not claimed from a rendered form.

Maestro's fixture must explicitly select its advertised Collaborative mode to
create the question. `full_auto=false` does not establish interaction mode:
the autonomous ask-user rejection was observed, then the Collaborative turn
created a fresh socket-observed ask with the expected text and revision.

Deployment also fixes the LaunchAgent's removed Homebrew Cellar executable
path. The installed definition now uses the stable Node symlink and is reloaded
through launchd; an authenticated call and the live wakeup verify the running
service after that repair.

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
