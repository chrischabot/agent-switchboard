# Local operation

The broker binds `127.0.0.1:8796`. Configuration defaults to
`~/.local/state/agent-switchboard/config.json`; `SWITCHBOARD_CONFIG` selects a
separate file. Keep the configuration, bearer files, SQLite database and its
WAL/SHM files private to the owning macOS account.

## Start and restart

`npm run hub` starts in the foreground. `npm run install:service` installs the
LaunchAgent `ai.chabot.agent-switchboard`. The installer updates an existing
plist but refuses to restart an already installed service implicitly.
It uses the stable Homebrew Node symlink when that link resolves to the running
Node executable. A versioned Cellar path can disappear during an upgrade.

Before a restart inspect the operation journal for every configured caller.
`operations_list` is scoped to its bearer principal. For a local administrative
check, read the SQLite database without modifying it:

```sh
sqlite3 -readonly ~/.local/state/agent-switchboard/broker.sqlite \
  "select principal,provider,status,count(*) from operations group by principal,provider,status;"
```

An in-flight provider write may become `outcome_unknown` after an abrupt stop.
It is not automatically retried. Investigate its native destination and preserve
its original receipt. Queued operations recover normally.

When no dispatch is in flight:

```sh
launchctl kickstart -k "gui/$(id -u)/ai.chabot.agent-switchboard"
```

This restarts only the broker and its `agy acp` child. It does not restart
Codex, Claude or the Antigravity IDE. An Antigravity turn the broker was
running is interrupted with the child; it is reported as lost, and its
conversation should be read before anything is sent again. Never run two
brokers against one state directory.

If the plist's executable or arguments changed, unload it with `launchctl
bootout` and reload the exact plist with `launchctl bootstrap`; `kickstart`
reuses the already-loaded definition. Check the authenticated endpoint afterward.

Use `node bin/call.mjs` with a JSON tool-call object on standard input for local
operator checks. `SWITCHBOARD_CALLER` selects another configured caller for a
transport test. Such a test is not evidence that the actual agent used its MCP
connection. Credentials never need to appear in shell arguments or tool output.

## Remote clients

The hub binds only to loopback, rejects any `Host` header other than
`127.0.0.1`, `localhost` or `[::1]`, and rejects every request that carries a
browser `Origin`. A remote MCP client, or a public webhook sender for the
receivers described below, can reach it through a tunnel or reverse proxy that
forwards to `http://127.0.0.1:8796`, rewrites `Host` to `localhost` and keeps
the client's bearer header. Give each remote client its own token and the
narrowest provider grant it needs.

The tunnel is transport only. The Mac owns SQLite, the desktop sockets, the
`agy` process, provider credentials and the webhook outbox. Machine sleep or
loss of connectivity stops remote access; it does not silently move desktop
work to another host.

Unauthenticated `/health` returns 401. An authenticated response establishes
broker availability and observed provider state, not end-to-end agent execution.

## Agent discovery freshness

`agents_list`, `switchboard://agents` and authenticated `/health` refresh the
caller's granted providers concurrently on every request. Claude scans its native
session registry; Codex checks its desktop IPC connection; Antigravity confirms
that its `agy acp` child is running and initialized, starting it if necessary.
Passthrough MCP adapters
use `server/discover` for modern MCP or `ping` for legacy MCP without closing live
transports, and disconnected adapters attempt to reconnect. Concurrent requests
share a provider's in-flight probe. No background polling is required.

Each provider has a five-second response deadline (`agentRefreshTimeoutMs` in
the private hub config, bounded to 1–15000 milliseconds). A timed-out probe keeps
running within the adapter's own limits and is shared by subsequent requests;
the hub does not start overlapping reconnects. Failure or timeout returns
`freshness: "stale"`, `availability: "unknown"` (or `auth_required` for a known
authentication failure), and a safe `refreshError` code. Historical catalog and
discovery fields remain available as old evidence. `observedAt` is the last
successful observation; `checkedAt` is when this request's check finished or
reached its deadline. Successful checks return `freshness: "fresh"`.

Claude `offline` after a fresh scan means no live locally owned Claude Code
session was found. It does not mean the Claude desktop application is closed.
Codex session discovery remains a bounded recent-session scan; `complete: false` and
`found: 0` do not establish that Codex has no sessions. A native MCP `ready`
result establishes MCP connectivity, not that every backing agent or lifecycle
action works. Capability verification remains separately declared or tested.
`observation` distinguishes `desktop_ipc` liveness from `session_discovery`;
`discoveryObservedAt` dates the session counts independently. Use `sessions_query`
to refresh Codex's owner-verified session list; registry health does not wait for
every recent thread's owner-discovery deadline.

## Tasks, resources and webhook delivery

Task state records provider-call completion. A task cancellation acknowledgment
may leave a dispatched operation working; stopping native agent execution is a
separate guarded operation. A restarted dispatch with an unknown outcome stays
unknown, including when a provider request might already have executed.

Resources invalidate caller-scoped journal projections. Read `events_read` with
an exclusive cursor to replay durable changes. Clients must handle dropped
notification streams and reconnect. Exact-session watches translate supported native events into the durable hub
journal. Unwatched sessions do not produce background observation traffic.

Webhook subscribers must use public HTTPS port 443. The sender validates and pins
public DNS addresses for every connection, refuses redirects, signs exact body
bytes, and verifies subscriptions with a signed challenge. Delivery uses bounded
attempts, expiry, 410/413 retirement and overlapping key rotation. A 2xx response
records webhook receipt; agent wakeup must be verified in the client separately.

## Receiving webhooks for local agents

Local Codex does not expose the Work Cloud webhook callback described in the
[OpenAI MCP Events integration](https://developers.openai.com/plugins/build/mcp-events).
Switchboard supplies `/webhooks/<route-id>` for an explicitly configured local
route. This endpoint authenticates the signed raw body, while `/mcp` and
`/health` continue to require their bearer tokens. A public sender reaches it
through the same kind of tunnel described under remote clients.

The private configuration's optional `webhookReceivers` array contains:

```json
{
  "id": "owned-route-unique-id",
  "principal": "operator",
  "secretFile": "/absolute/private/path/signing.secret",
  "subscriptionId": "exact-upstream-subscription-id",
  "event": "session.turn.ended",
  "filter": { "provider": "antigravity", "sessionId": "exact-source-id" },
  "notify": { "provider": "codex", "sessionId": "exact-destination-id" },
  "expiresAt": 1793000000000,
  "maxDeliveries": 1
}
```

Set a future expiry in Unix milliseconds and a delivery bound of 1–100. The
secret file contains a `whsec_` key and must be private. For a Switchboard
subscription, its identity is `fingerprint([principal, callbackUrl, event,
subscriptionArguments])` from `src/store.mjs`. Configure the receiver before
calling `events/subscribe`, so it can answer the signed verification challenge.
Source filters are checked against every event. Session events require an exact
source session; operation events can also filter `operationId` and `status`.

Every accepted event is persisted before the HTTP acknowledgment. The receiver
delivers only to the configured destination, preserving native permissions and
the peer-data boundary. Event IDs deduplicate across process restarts, and a
stable native dispatch identity closes the crash window between recording a
dispatch and recording its inbox association. Reusing an ID with changed data
returns 409; stale signatures, wrong subscription IDs and unexpected sources
are rejected. An uncertain native dispatch is never silently sent again.

Inspect `webhook_inbox` for `pending`, `dispatched` or `failed`, and inspect the
referenced operation and native transcript for actual completion. `dispatched`
does not assert model success. Routes expire and delivery bounds persist across
restarts. Changing a route's settings requires a new ID. Removing its config
disables receipt and recovery without deleting evidence.

## Human elicitation

Codex may immediately return `decline` under `approval_policy = "never"`.
Full-access standard forms require additional frontend support; do not treat
an immediate client decline as a human decision. Only the user changes their
chat permission policy or submits the form.

An Antigravity permission request becomes a question owned by the client that
sent the message. Its journal records `question.created`, whose `object_id`
is the question ID and whose data names the message operation; a watch on the
session also records `session.input_required`. Call `questions_present` with
that ID from a client that supports form elicitation. The form lists exactly
the options Antigravity offered, such as allow once, always allow and reject.
Only a human choice of one of those options is relayed. Decline, cancel, an
answer outside the offered options and a timeout (`permissionTimeoutMs`, ten
minutes by default) all answer the agent with its reject-once option, or with
ACP's cancelled outcome when it offered none. A stop, or the end of the turn,
answers any pending request as cancelled, as ACP requires.
Choosing an "always" option is a human decision that Antigravity may remember
beyond this turn. A question left unanswered stays in the journal after the
request has been settled; answering it later has no effect.

## Acceptance and recovery

Run `npm test` for controlled protocol, authorization, crash/recovery and adapter
regressions. `npm run test:live` runs the read-only matrix. See
[live-matrix.md](live-matrix.md) for exact-fixture mutations and evidence rules.
Private reports and raw transcripts stay under ignored `evidence/live/`.

For an unknown send, first inspect the recorded native target, message identity
and transcript. Do not generate a new request ID to retry the same uncertain
intent. A confirmed native rejection can support a corrected new request; retain
the original failure so the record remains auditable.

Known limits include version-sensitive desktop IPC, partial desktop inventories,
Claude's short immediate-receipt window, and Antigravity observation that covers
only the turns the broker starts. Local webhook-to-Codex delivery does not claim
built-in Work Cloud ingress in local Codex. Capabilities and live reports must
keep these distinctions.
