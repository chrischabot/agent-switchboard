# Architecture

One Mac service owns the provider connections, capability registry, operation
journal, event watches and webhook outbox. MCP hosts use small stdio clients
that forward to this service over loopback HTTP.

```mermaid
flowchart LR
  C[Codex MCP client] --> H[Switchboard on the Mac]
  D[Claude MCP client] --> H
  A[Antigravity MCP client] --> H
  H --> S[(Private SQLite journal)]
  H --> I[Codex desktop IPC and history]
  H --> J[Claude session registry and peer sockets]
  H --> P[agy acp child process]
```

The Mac owns the desktop IPC, the session records and the `agy` process, so
it is the deployment authority. Node supplies the adapters, the maintained MCP
SDK and built-in SQLite.

Each bearer principal has explicit provider grants and its own operation,
subscription and event views. Provider credentials remain local. Native tools
remain available alongside the normalized session operations. The registry
exposes exact input schemas, read-only semantics, availability and limitations;
it never invents a missing native lifecycle operation.

## Operations and notifications

Writes enter SQLite before dispatch. A stable caller request ID identifies the
intent and canonical arguments. Identical retries return the same receipt;
changed arguments conflict. A broker crash during dispatch preserves an unknown
outcome and never replays that write automatically.

MCP Tasks describe provider-call completion. They do not claim that an agent
finished its turn. Resource subscriptions invalidate durable journal views.
MCP Events deliver signed webhooks to compatible receivers. Human elicitation
relays native requests, such as Antigravity permission requests, to the
human-facing client, and only a human response travels back.

Exact-session watches adapt native events into bounded metadata. Desktop
sources observe transcript appends; Antigravity sources observe the ACP
notifications of turns the broker starts. Watches have finite lifetimes,
durable source cursors and explicit gap events.
Follow-ups send a bounded number of peer notifications and retain the native
delivery receipt. See [event subscriptions](events.md) for the catalog and
the watch-before-start sequence.

## Codex desktop

The adapter reads recent session metadata from `state_5.sqlite` under
`CODEX_HOME`, which defaults to `~/.codex`. It connects to `ipc/ipc.sock` in that
directory and verifies that the socket is private and owned by the local user.
Saved records establish candidates, not liveness: the application must identify
a running owner for each listed session.

Frames contain a 4-byte little-endian payload length followed by UTF-8 JSON.
Switchboard initializes with its own `agent-switchboard` client type and receives
a client ID. It does not reuse another client's identity.

The following table records the application requests used by the adapter:

| Request | Version | Purpose |
| --- | --- | --- |
| `initialize` | 0 | Registers the local client |
| `thread-owner-discovery` | 1 | Finds a conversation's live owner |
| `thread-follower-start-turn` | 2 | Submits a turn to an existing idle conversation |
| `thread-follower-steer-turn` | 1 | Sends a message to an active turn |
| `thread-follower-interrupt-turn` | 4 | Interrupts the exact guarded active turn |

The adapter reads recent `userMessage` and `agentMessage` items and the latest
recorded turn status from `thread_history_1.sqlite` through a read-only SQLite
connection. This projection can lag live generation. The active-turn check
before `start` is therefore advisory; the owner's response is authoritative.

These interfaces and database names are implementation details of the inspected
application, not a public compatibility contract. The adapter does not use the
separate, code-signing-restricted application-tools pipe or weaken its checks.

## Claude Code

The adapter discovers numeric process records under
`CLAUDE_CONFIG_DIR/sessions`, with `~/.claude` as the default configuration
directory. It verifies each process ID against the recorded start time, using
UTC for the `ps` comparison to avoid time-zone mismatches and stale PID reuse.

For sends, it checks socket ownership and permissions and uses `lsof` to confirm
that the registered process owns the socket. If the process has published a
peer key, the adapter reads it from a private file and sends an authentication
frame before the message. It does not return the key through MCP.

The inbox protocol uses newline-delimited JSON. Each message identifies the
exact destination session and has a fresh message ID. A short-lived reply
socket collects policy receipts correlated by message ID and sender address.
It closes after the bounded receipt window, so delayed receipts and idle
notifications are not retained.

When the host supplies a Codex task ID through executor metadata or
`CODEX_THREAD_ID`, the adapter reads that task's stored approval and sandbox
settings to describe its sender context. Missing or unrecognized context stays
unknown. There is no caller-selected permission mode, and the adapter never
copies the destination's mode or approves a held message. These are same-user
metadata checks, not protection against a malicious local process that can
alter the same files or environment.

Transcript reads resolve the live session's working directory and UUID to a
project transcript. They include user and assistant text, omit tool results and
reasoning blocks, and report truncation. Alternate transcript layouts need a
separate adapter.

## Antigravity

The adapter starts the configured command, normally `agy acp`, as one child
process owned by the hub, and exchanges JSON-RPC 2.0 messages with it, one per
line, over stdio. It initializes with ACP protocol version 1 and empty client
capabilities, so it offers the agent no filesystem or terminal access of its
own; any such request from the agent is refused as an unsupported method. The
agent's stderr is drained and never relayed. When the process exits, every
outstanding request fails, every running broker turn is marked lost, watchers
receive a gap event, and the process is restarted with a backoff that grows
from half a second to thirty seconds.

| ACP method | Used for |
| --- | --- |
| `initialize` | Version and capability negotiation on every process start |
| `session/list` | `sessions.list`, and resolving a session's working directory |
| `session/load` | `sessions.read` (history replay), and opening a session before a prompt |
| `session/close` | Releasing a session opened only to read it, or after a broker turn ends |
| `session/resume` | `sessions.resume`: opening a session without replay |
| `session/new` | `sessions.create` in an absolute working directory |
| `session/prompt` | `sessions.message`, and the optional first prompt of `sessions.create` |
| `session/cancel` | `sessions.stop` for the exact running broker turn |
| `session/request_permission` | Agent-to-client; relayed to the human, otherwise rejected once |

A read of a session the broker does not have open sends `session/load`,
collects the `session/update` notifications that replay its history, and closes
the session again. The projection keeps user and agent text and tool call
titles with their final status, drops agent reasoning, keeps at most about two
megabytes, and returns the most recent `maxChars` characters. A read of a
session the broker has open returns its buffer instead, which also contains
the turn in progress.

A message loads the session if needed, assigns a turn ID, prefixes the text
with the same peer label the desktop adapters use, and sends `session/prompt`.
ACP replies to a prompt only when its turn ends, so the adapter waits
`promptGraceMs` for an immediate refusal: a JSON-RPC error in that window
becomes a failed receipt, a process exit becomes `outcome_unknown`, and
otherwise the receipt reports `prompt-sent` with the turn ID while the turn
continues. The turn's later `session/update` notifications become block
events, and the prompt's reply becomes `session.turn.ended` with ACP's
`stopReason` as the outcome. Session work is serialized per session, so loads,
prompts, resumes and closes never interleave. Status reports only turns the
broker started; for any other session it confirms that the conversation exists
and says that activity elsewhere is not observed.

The Antigravity IDE and other `agy` processes keep their own sessions. The
broker's process shares their conversation store, which is why it can list and
replay every conversation and add a turn to one, but it has no view of their
in-memory state, their running turns or their permission prompts.

## Trust and failure handling

The broker durably records dispatch receipts and caller-scoped events. Client
tool approvals and destination permissions remain authoritative. A transport
acknowledgment, queue receipt and completed agent response are different
outcomes. A signed webhook acknowledgment establishes receiver receipt;
an actual client journey must establish model wakeup separately.

The socket checks reduce stale-target risk but do not verify the connected
peer's process ID at the kernel level. Receipt correlation is not authenticated
peer identity. The implementation is not hardened against a hostile process
running under the same local account or endpoint replacement between a check
and connection.

Do not edit live conversation databases, rewrite transcripts, change inbound
message policy, or disable permission checks to force delivery. After uncertain
delivery, inspect the receiving conversation before resubmitting.
