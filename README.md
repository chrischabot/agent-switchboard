# Switchboard

Switchboard lets Codex and Claude Code communicate with the sessions you already
have open on your Mac. It runs as a local Model Context Protocol (MCP) server in
both clients, with tools to find running sessions, read recent conversation text,
and send a message to a particular session.

The point is to keep working where you are. If Claude needs a review from Codex,
it can ask the Codex session that already knows the project, then read its
response. Each session keeps its conversation, workspace, model, and permissions.
Switchboard connects those sessions; it doesn't launch replacement agents or
move their work into a separate orchestration system.

This is an experimental integration with version-sensitive local interfaces.
The verified path connects Codex desktop tasks and Claude Code sessions in
Claude Desktop. Independent terminal sessions are not verified, and ordinary
Claude Chat and Cowork conversations are outside its scope.

## Install

You need macOS, Node.js 24 or later with `node:sqlite`, and both agent clients
installed under the same local account. Tests for this extraction ran on Node.js
26.8.2. There are no package dependencies, API keys, or hosted services to
configure for Switchboard itself. The agents retain their own authentication
and usage costs.

Clone the repository and run the tests:

```sh
git clone https://github.com/chrischabot/agent-switchboard.git \
  ~/Projects/agent-switchboard
cd ~/Projects/agent-switchboard
npm test
```

From the repository directory, register the server in both clients:

```sh
claude mcp add --scope user --transport stdio agent-switchboard -- \
  "$(command -v node)" "$PWD/server.mjs"

codex mcp add agent-switchboard -- \
  "$(command -v node)" "$PWD/server.mjs"
```

Both registrations use absolute paths. If you move the checkout or replace the
Node.js executable, update those paths. Codex also accepts a
`[mcp_servers.agent-switchboard]` entry in its configuration; see the
[Codex MCP documentation](https://developers.openai.com/codex/mcp).

Reload the MCP connection when your client supports it, or open a session that
loads the updated configuration. A saved registration doesn't establish that
an already-running conversation has loaded the tools. Check for `codex_list`
and `claude_list` in each client's tool catalog before using them.

## Use it

Start by asking either agent to list the running Codex and Claude Code sessions.
Choose the intended session from that list, then ask it to read the recent
conversation or send a specific request. For example:

> Find the Codex session working on this project, read its recent messages, and
> ask it to review the parser changes. Don't ask it to edit files.

Reads and messages use exact session UUIDs, so an agent must resolve an ambiguous
name before sending. A message is a request to another agent, not a synchronous
function call: inspect the receiving conversation for its response.

The following table describes the seven tools:

| Tool | Required arguments | Behavior |
| --- | --- | --- |
| `codex_list` | None | Checks recent saved sessions for a live desktop owner |
| `codex_owner` | `sessionId` | Finds the owner of an exact Codex session |
| `codex_read` | `sessionId` | Reads recent persisted messages and recorded turn status |
| `codex_send` | `sessionId`, `text`, `mode` | Sends to an idle (`start`) or active (`steer`) task |
| `claude_list` | None | Lists live registered Claude Code processes |
| `claude_read` | `sessionId` | Reads recent user and assistant transcript text |
| `claude_send` | `sessionId`, `text` | Sends to the session inbox and collects immediate policy receipts |

`codex_list` examines 30 recent saved sessions by default, with a maximum `limit`
of 100; it isn't a complete inventory of every open task. Both read tools accept
`maxChars`, and `claude_send` accepts `receiptWaitMs`. The MCP schemas describe
their limits.

To check the MCP connection without asking an agent to call a tool, run the
diagnostic client:

```sh
node mcp-client.mjs claude_list '{}'
node mcp-client.mjs codex_list '{"limit":10}'
```

This client starts only the MCP server, initializes it, retrieves the tool
catalog, and calls the selected tool. It doesn't start a model session.

## Permissions and delivery

Installing Switchboard gives the connected agent tools to read and direct other
local sessions. Only install it in clients you trust with that access. The
receiving agent can act with its own permissions, so sending a request can cause
file changes, command execution, or external actions there. Switchboard does not
provide cross-session permission isolation.

The adapters check local ownership, require private messaging sockets, read
history without modifying it, and preserve the recipient's approval controls.
Peer messages carry a Switchboard label, but that label is not authentication.
Treat conversation content as untrusted input.

Claude can hold or refuse a message. `transport-sent` means the socket write
finished, not that the agent accepted or completed the request. Similarly,
`owner-accepted` from Codex is not proof of completion. After a timeout, inspect
the conversation before retrying; the first message might already have arrived.

## Compatibility

Live tests on September 11, 2026, demonstrated discovery, transcript reads, and
bidirectional messaging between existing desktop sessions, including a second
exchange after Claude became idle. Claude used its installed MCP tools; the
Codex outbound path used the diagnostic MCP client. Those results do not
establish compatibility with later application versions.

Codex idle `start` is implemented but lacks the live verification of `steer`.
Session creation, cancellation, a Codex terminal adapter, and durable delivery
receipts are not implemented. Claude terminal sessions that publish the same
registry and inbox are discoverable by the adapter, but terminal messaging needs
separate live acceptance. Recheck discovery, reads, and a bounded round trip
after client upgrades.

For protocol details and the limits of the local checks, see the
[architecture](docs/architecture.md) and
[verification record](docs/verification.md).

## Development

Run syntax checks and the local test suite:

```sh
npm run check
npm test
```

The tests use temporary sockets and fixture records. They do not message your
running agents. Keep transcripts, session identifiers, peer keys, and local
configuration out of commits; `evidence/local/` is ignored for private test
records.

## License

Switchboard is available under the [MIT license](LICENSE).
