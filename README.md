# Agent Switchboard

Agent Switchboard is a local MCP service that connects existing Codex and Claude
Code desktop sessions, Fabric, and Maestro. Clients share a capability registry
and session/project interface; each provider also exposes its native tools.
The broker preserves the native session owner, permissions and spending controls.

The service runs on the Mac because the two desktop adapters require local IPC.
Fabric and Maestro reach it through authenticated HTTPS, normally a Cloudflare
Tunnel. The tunnel supplies ingress; Node and SQLite on the Mac own dispatch,
receipts and event delivery. A sleeping or disconnected Mac is unavailable.

## Status

The implementation and automated protocol tests cover durable operations,
MCP Tasks, resource subscriptions, human elicitation relay and MCP Events
webhooks. Live acceptance is in progress. A registered connection, a dispatch
receipt and completed agent work are different claims. See the
[live matrix](docs/live-matrix.md) and [implementation record](docs/implementation-plan.md).
The [protocol compatibility notes](docs/protocols.md) distinguish webhook
receipt, resource invalidation, Tasks and native agent wakeup.

| Provider | Normalized surface | Material limits |
| --- | --- | --- |
| Codex desktop | Recent owned-session list, read, status projection, message, steer, exact-turn stop | Peer IPC does not expose project CRUD or session creation/archive/delete. A bounded empty list is not proof that no desktop sessions exist. |
| Claude Code in Desktop | Live-session list, transcript/status projection, peer message | Broader lifecycle is app-internal. Receipt timeout can leave delivery unknown even when a later transcript proves execution. |
| Fabric | Session/project operations backed by connected Tutti tools | Live tool catalog determines availability. Session resume needs a prompt. New projects default to manual mode; project restore returns paused. Project deletion requires a native lifecycle preview token. |
| Maestro | Session/project operations and native tool families | Native project capabilities, budget policy and current action schemas govern each operation. |

`capabilities_get` reports exact supported operations, normalized input schemas,
read-only semantics, observed availability and provider versions. Unsupported
operations remain explicit. This service does not manufacture desktop lifecycle
support from unrelated host tools or substitute a separate CLI conversation.

## Install

Use macOS with Node.js 24 or later and `node:sqlite`:

```sh
npm ci
npm run check
npm test
```

Create a private directory such as `~/.local/state/agent-switchboard` with mode
`0700`. Keep `config.json` and separate random bearer-token files for `operator`,
`codex`, `claude`, `fabric` and `maestro` there, all mode `0600`. Each token must
have at least 32 characters; use 32 random bytes or more. Never commit them.

## Configuration

Use absolute paths and configure each provider explicitly. The desktop entries
select the local IPC adapters.

```json
{
  "port": 8796,
  "stateDir": "/absolute/private/switchboard",
  "clients": {
    "operator": { "tokenFile": "/absolute/private/operator.token", "providers": ["codex", "claude", "fabric", "maestro"] },
    "codex": { "tokenFile": "/absolute/private/codex.token", "providers": ["codex", "claude", "fabric", "maestro"] },
    "claude": { "tokenFile": "/absolute/private/claude.token", "providers": ["codex", "claude", "fabric", "maestro"] },
    "fabric": { "tokenFile": "/absolute/private/fabric.token", "providers": ["codex", "claude", "fabric", "maestro"] },
    "maestro": { "tokenFile": "/absolute/private/maestro.token", "providers": ["codex", "claude", "fabric", "maestro"] }
  },
  "providers": {
    "codex": { "kind": "desktop" },
    "claude": { "kind": "desktop" },
    "fabric": {
      "url": "https://your-fabric.example/tutti",
      "tokenFile": "/absolute/private/fabric-native.token",
      "supportsInputRequired": true
    },
    "maestro": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/maestro-mcp/bin/maestro-mcp.mjs"],
      "env": { "MAESTRO_BROKER_SOCKET": "/absolute/private/maestro/broker.sock" },
      "supportsInputRequired": true
    }
  }
}
```

`supportsInputRequired` pins the native connection to MCP `2026-07-28` and enables
form/URL elicitation relay. Set it only for a verified compatible provider.
For Fabric, `codexCredential: {file, serverName}` can replace `tokenFile`; the
adapter rereads the matching exact-endpoint OAuth credential on every request.
The native credential grants access to Fabric. Client tokens above grant access
to this broker; these are separate credentials.

Start `node bin/hub.mjs`, or install its LaunchAgent with
`node bin/install-service.mjs`. Set `SWITCHBOARD_CONFIG` when using a nondefault
configuration path. See [operations](docs/operations.md) for restart and tunnel
behavior.

Register `node /absolute/path/to/agent-switchboard/bin/client.mjs` as a stdio MCP
server in each desktop client. Set its `SWITCHBOARD_TOKEN_FILE` to that client's
private token file. Set `SWITCHBOARD_URL` if you change the default local port.
The shim connects to the shared local service; it does not
start a second broker. Existing conversations may need an MCP reload or a new
session to load updated registration.

For Fabric and Maestro use the tunnel's HTTPS `/mcp` endpoint and the respective
client bearer token. Maestro's connector is `agent_switchboard` with credential
service type `agent_switchboard_mcp`; store the URL in `metadata.mcp_endpoint`.
Enable the integration in the exact intended session or project through native
capability controls. Saving credentials alone does not enable an agent tool.

## Use

Call `agents_list`, then `capabilities_get` for the target provider. A status
request uses this shape:

```json
{ "provider": "maestro", "action": "status", "input": { "id": "exact-native-session-id" } }
```

Use the read-only `sessions_query` tool for that request. Mutations add a stable
`input.requestId`; reusing it with changed arguments is refused. Use
`provider_tools_list` with an exact name before `provider_call` for functions
outside the normalized interface. For mixed native tool families, consult the
provider's action schema as well as its broad discovery schema.

A mutation returns an operation receipt or an MCP Task when the client supports
Tasks. Inspect native status/transcripts to establish execution completion.
Cancellation of a Task only cancels queued dispatch; stopping a running agent
requires `sessions` with action `stop` and any native exact-turn guard.

## Session event subscriptions

Use `events_catalog` to discover turn, error, output block, input request, state,
and observation gap events. Use `events_watch` for a durable exact-session
journal, MCP Events for signed webhooks, or `events_follow` for a bounded peer
notification to another session. See [event subscriptions](docs/events.md) for
the catalog, race-free job subscription sequence, and provider limits.

## Protocols and delivery

- **Tasks:** durable caller-scoped task handles, status, cancellation
  acknowledgment and input-response continuation. Unknown dispatch outcomes are
  retained across restart and never replayed automatically.
- **Subscriptions:** resource invalidation notifications and replayable local
  journal cursors. Resource notifications do not themselves start model turns.
- **Elicitation:** bounded native form/URL input requests, with responses supplied
  through the MCP client's human interaction path. No model answer argument is
  exposed as human authorization.
- **Events:** webhook subscription verification, signed delivery, durable
  cursors, expiry, bounded retries and key rotation. Webhook acknowledgment does
  not establish a client wakeup or model action. Host acceptance remains a
  separate live test, especially for local desktop clients.

All peer content stays untrusted. Native approval controls remain authoritative.
The broker does not provide isolation between an authorized caller and the
recipient agent's granted tools. Use distinct tokens and narrow provider grants.

## Verification

`npm test` uses controlled services, temporary databases and sockets; it does not
message running agents. `npm run test:live` exercises registered connections and
read-only fixture checks, writing private reports under ignored `evidence/live/`.
Mutation and actual originating-agent tests need exact dedicated fixtures and
separate recorded evidence. See [the matrix runbook](docs/live-matrix.md).

The original seven-tool desktop-only stdio entrypoint remains at `server.mjs`.
Its [legacy guide](docs/desktop-legacy.md) and [protocol notes](docs/architecture.md)
describe that narrower interface.

[MIT license](LICENSE).
