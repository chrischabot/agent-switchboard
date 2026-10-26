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

This restarts only the broker. It does not restart Codex, Claude, Fabric or
Maestro. Restart a native Maestro broker only through its own profile-specific
LaunchAgent, after checking its tasks. Never run two writable brokers against
one native state directory.

If the plist's executable or arguments changed, unload it with `launchctl
bootout` and reload the exact plist with `launchctl bootstrap`; `kickstart`
reuses the already-loaded definition. Check the authenticated endpoint afterward.

Use `node bin/call.mjs` with a JSON tool-call object on standard input for local
operator checks. `SWITCHBOARD_CALLER` selects another configured caller for a
transport test. Such a test is not evidence that the actual agent used its MCP
connection. Credentials never need to appear in shell arguments or tool output.

## Remote ingress

Use a named Cloudflare Tunnel with a dedicated configuration and LaunchAgent.
Its route points to `http://127.0.0.1:8796`; set
`originRequest.httpHostHeader: localhost`. Retain the client bearer header.
The origin rejects nonlocal Host values and browser Origin requests. The default
Cloudflare configuration may belong to another application: always pass this
tunnel's explicit `--config` path when creating routes or running it.

The tunnel is transport only. The Mac owns SQLite, native desktop sockets,
provider credentials and the webhook outbox. No Worker stores authoritative
session or task state. Machine sleep or loss of connectivity stops remote
access; it does not silently move desktop work to another host.

Unauthenticated `/health` returns 401. An authenticated response establishes
broker availability and observed provider state, not end-to-end agent execution.

## Agent discovery freshness

`agents_list`, `switchboard://agents` and authenticated `/health` refresh the
caller's granted providers concurrently on every request. Desktop adapters scan
their native session registry; connected MCP adapters ping without closing live
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
Codex discovery remains a bounded recent-session scan; `complete: false` and
`found: 0` do not establish that Codex has no sessions. A native MCP `ready`
result establishes MCP connectivity, not that every backing agent or lifecycle
action works. Capability verification remains separately declared or tested.

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
`/health` continue to require their bearer tokens. The tunnel remains unchanged.

The private configuration's optional `webhookReceivers` array contains:

```json
{
  "id": "owned-route-unique-id",
  "principal": "operator",
  "secretFile": "/absolute/private/path/signing.secret",
  "subscriptionId": "exact-upstream-subscription-id",
  "event": "session.turn.ended",
  "filter": { "provider": "fabric", "sessionId": "exact-source-id" },
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
an immediate client decline as a human decision. On request permissions were
observed to display the actual native form in the October 25 live check.
Only the user changes their chat permission policy or submits the form.

Maestro must be in **Collaborative** interaction mode to create an ask-user
question. `full_auto=false` alone does not establish that mode; a fixture message
can explicitly select the advertised `collaborative` mode. Questions retain
their exact native ask ID and revision. If presentation times out, the durable
operation remains `waiting_input`; inspect it before presenting the same pending
question again. Do not invent a response or confuse an old stopped card with a
new live ask.

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
Claude's short immediate-receipt window, no native desktop project CRUD, no
cross-process native Maestro subscription reconnect. Native Codex human-form
acceptance through Maestro and local webhook-to-Codex wakeup are live-qualified;
this does not claim built-in Work Cloud ingress in local Codex.
Capabilities and live reports must keep these distinctions.
