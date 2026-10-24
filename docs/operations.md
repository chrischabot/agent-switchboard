# Local operation

The broker binds `127.0.0.1:8796`. Configuration defaults to
`~/.local/state/agent-switchboard/config.json`; `SWITCHBOARD_CONFIG` selects a
separate file. Keep the configuration, bearer files, SQLite database and its
WAL/SHM files private to the owning macOS account.

## Start and restart

`npm run hub` starts in the foreground. `npm run install:service` installs the
LaunchAgent `ai.chabot.agent-switchboard`. The installer updates an existing
plist but refuses to restart an already installed service implicitly.

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

## Tasks, resources and webhook delivery

Task state records provider-call completion. A task cancellation acknowledgment
may leave a dispatched operation working; stopping native agent execution is a
separate guarded operation. A restarted dispatch with an unknown outcome stays
unknown, including when a provider request might already have executed.

Resources invalidate caller-scoped journal projections. Read `events_read` with
an exclusive cursor to replay durable changes. Clients must handle dropped
notification streams and reconnect. Upstream provider resource events are not
yet translated into the hub journal; only hub operation events are durable here.

Webhook subscribers must use public HTTPS port 443. The sender validates and pins
public DNS addresses for every connection, refuses redirects, signs exact body
bytes, and verifies subscriptions with a signed challenge. Delivery uses bounded
attempts, expiry, 410/413 retirement and overlapping key rotation. A 2xx response
records webhook receipt; agent wakeup must be verified in the client separately.

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
cross-process native Maestro subscription reconnect, and no live-qualified host
webhook wakeup yet. Capabilities and live reports must keep these distinctions.
