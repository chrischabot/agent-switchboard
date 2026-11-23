# Agent Switchboard

Agent Switchboard lets the coding agents you already have running work with each other. It is a local MCP service for people who keep several agents going at once on a Mac: it connects live Codex desktop and Claude Code sessions, along with Antigravity conversations, so that any one of them can find another's session, read its recent conversation, send it a message and be told when its turn ends.

It exists because a session is where the useful context lives. When Claude needs a review from Codex, the Codex session already working on that project knows the code, the decisions made so far and what it has been allowed to do, while a freshly started agent knows none of this and has to be brought up to speed. Switchboard therefore connects the sessions you have rather than launching replacements or moving their work into a separate orchestrator. Each session keeps its conversation, workspace, model and permissions, and a message from another agent arrives as peer input that the recipient's own approval controls still govern.

## How it works

One long-running Node process on the Mac owns the provider connections and a private SQLite journal of operations and events. Each MCP client runs a small stdio shim that forwards to this process over loopback HTTP. The service has to live on the Mac because the adapters depend on local interfaces. The Codex adapter talks to the desktop app's IPC socket and reads its SQLite history, and the Claude adapter finds live processes from their session records and writes to each session's peer-messaging socket. For Antigravity, the hub starts one long-lived `agy acp` process and speaks the [Agent Client Protocol](https://agentclientprotocol.com) to it over stdio, restarting it if it exits.

Every agent sees the same MCP interface. `agents_list` and `capabilities_get` report which providers are connected and exactly what each can do, `sessions` offers normalized operations on exact native session IDs, and `provider_call` passes through to native tools outside that interface. Anything a provider cannot do stays explicitly unsupported, with a reason where one helps, so Switchboard will not quietly substitute a new CLI worker for a desktop session it has no way to create.

Messaging a running agent is not a call you can safely repeat, because the message may start paid work and a timeout says nothing about whether it arrived. So every write is committed to SQLite under a caller-supplied request ID before it is dispatched. Retrying with the same ID and arguments returns the original receipt, changing the arguments is refused as a conflict, and a write interrupted by a crash becomes `outcome_unknown` and is never resent automatically. A receipt describes only the dispatch, so whether the agent did the work has to be established from its native status or transcript.

Sessions can also be watched. `events_watch` follows one exact session, tailing the desktop apps' transcript files or listening to the ACP notifications of an Antigravity turn, and records bounded metadata about turns, output blocks and errors in a durable journal. `events_follow` then turns a matching event into a limited number of notifications to another session, which is what lets one agent finish a job and another pick it up without having to poll for it.

## What each provider supports

| Operation | Codex desktop | Claude Code | Antigravity |
| --- | --- | --- | --- |
| List, read and check status of sessions | Yes | Yes | Yes |
| Message a session | Yes | Yes | Yes |
| Steer an active turn | Yes | No | No |
| Stop a turn | Yes | No | Turns started by Switchboard |
| Create and resume sessions | No | No | Yes |
| Watch turns and blocks | Yes | Yes | Turns started by Switchboard |

`capabilities_get` reports the exact operations, input schemas and read-only semantics at runtime. Stopping a turn requires its current `expectedTurnId`. Codex has no separate resume operation, though messaging a session continues the same thread, and Claude queues a peer message for the session's next opportunity rather than interrupting it.

Antigravity's column needs one qualification, because of where its turns run. Switchboard reaches Antigravity through its own `agy acp` process, which shares the conversation store with the Antigravity IDE and any other `agy` process but is otherwise separate from them. Listing and reading cover every stored conversation, since a read replays the conversation's history with `session/load`. A message, however, runs a new turn in the broker's process on that shared conversation, and only those broker-started turns can be watched, reported by status or stopped. A conversation you have open in the IDE at the same moment is not coordinated with that turn, and work happening there is invisible to Switchboard. ACP has no way to add input to a running turn, so steering is unsupported and a second message is refused while a broker-started turn is still running.

## Install

Switchboard is an experimental, macOS-only service that needs Node.js 24 or later. Install it from this repository, because the `agent-switchboard` package on npm is an unrelated project.

```sh
git clone https://github.com/chrischabot/agent-switchboard.git
cd agent-switchboard
npm ci
```

Antigravity support needs the `agy` CLI installed and signed in under the same macOS account.

## Configure

Create a private directory with one bearer token per client. The service refuses to start with a token shorter than 32 characters.

```sh
state="$HOME/.local/state/agent-switchboard"
mkdir -p -m 700 "$state"
(umask 077; for client in operator codex claude antigravity; do openssl rand -hex 32 > "$state/$client.token"; done)
```

Then write `config.json` in that directory with mode `0600`. The service looks there by default, and `SWITCHBOARD_CONFIG` selects a different file. Use absolute paths, including for `agy`, because a LaunchAgent does not inherit your shell's `PATH` (`command -v agy` prints it).

```json
{
  "port": 8796,
  "stateDir": "/Users/you/.local/state/agent-switchboard",
  "clients": {
    "operator": { "tokenFile": "/Users/you/.local/state/agent-switchboard/operator.token", "providers": ["codex", "claude", "antigravity"] },
    "codex": { "tokenFile": "/Users/you/.local/state/agent-switchboard/codex.token", "providers": ["codex", "claude", "antigravity"] },
    "claude": { "tokenFile": "/Users/you/.local/state/agent-switchboard/claude.token", "providers": ["codex", "claude", "antigravity"] },
    "antigravity": { "tokenFile": "/Users/you/.local/state/agent-switchboard/antigravity.token", "providers": ["codex", "claude"] }
  },
  "providers": {
    "codex": { "kind": "desktop" },
    "claude": { "kind": "desktop" },
    "antigravity": { "kind": "acp", "command": "/Users/you/.local/bin/agy", "args": ["acp"] }
  }
}
```

A client's `providers` list is everything its token can reach, so narrow it for any client that needs less. Keep these client and provider names: `bin/call.mjs` uses `operator` by default, the broker only accepts Codex's sender metadata, which Claude's peer policy looks at, from the client named `codex`, and the adapters are selected by provider name. Leave out any provider you do not use.

The Antigravity entry also accepts `env` and `cwd` for the child process (a LaunchAgent's `PATH` is minimal, so set `env.PATH` if the tools Antigravity runs live elsewhere), `permissionTimeoutMs` (how long a permission request waits for a human answer, ten minutes by default), `promptGraceMs` (how long a message waits for an immediate refusal before its receipt is written, one second by default), and `requestTimeoutMs` and `loadTimeoutMs` for ordinary ACP requests and history replays. Switchboard refuses to start the agent with an argument such as `--dangerously-skip-permissions`, because that would approve on your behalf every request the relay below is meant to bring to you.

## Run and connect

Start the service in the foreground with `npm run hub`, or install it as a LaunchAgent with `npm run install:service`, which logs to `service.log` in your `stateDir`. You can then check it from a terminal as the `operator` client:

```sh
echo '{"name":"agents_list","arguments":{}}' | node bin/call.mjs
```

From the repository directory, register the shim in each agent with its own token:

```sh
claude mcp add --scope user --transport stdio agent-switchboard \
  --env SWITCHBOARD_TOKEN_FILE="$HOME/.local/state/agent-switchboard/claude.token" \
  -- "$(command -v node)" "$PWD/bin/client.mjs"

codex mcp add agent-switchboard \
  --env SWITCHBOARD_TOKEN_FILE="$HOME/.local/state/agent-switchboard/codex.token" \
  -- "$(command -v node)" "$PWD/bin/client.mjs"

agy mcp add --env SWITCHBOARD_TOKEN_FILE="$HOME/.local/state/agent-switchboard/antigravity.token" \
  agent-switchboard "$(command -v node)" "$PWD/bin/client.mjs"
```

Set `SWITCHBOARD_URL` as well if you changed the port. The shim connects to the shared service rather than starting a second broker, and conversations that were already open may need an MCP reload or a new session before they see the tools. Registering the shim in Antigravity is optional and independent of the Antigravity provider: the provider lets other agents reach Antigravity conversations, while the shim lets Antigravity reach the others.

The hub listens only on `127.0.0.1`. A remote MCP client can reach its `/mcp` endpoint through a tunnel of your choosing, as [local operation](docs/operations.md#remote-clients) describes.

## Use

Once the tools are loaded, you can simply ask an agent for what you want:

> Find the Codex session working on this project, read its recent messages, and ask it to review the parser changes. Don't ask it to edit files.

Underneath, the agent calls `agents_list` and `capabilities_get`, then `sessions_query` for passive reads, which spares native clients from approving a tool that can also write:

```json
{ "provider": "antigravity", "action": "status", "input": { "id": "exact-native-session-id" } }
```

Writes go through `sessions` and carry a stable `requestId`:

```json
{ "provider": "codex", "action": "message", "input": { "id": "exact-native-session-id", "text": "Please review the parser changes.", "requestId": "parser-review-001" } }
```

A write returns an operation receipt, or an MCP Task when the client supports Tasks. Cancelling it only cancels dispatch that has not happened yet, and stopping a running agent takes `sessions` with action `stop`. An Antigravity message receipt carries the `turnId` that Switchboard assigned to the turn, which is the `expectedTurnId` a stop needs. For functions outside the normalized interface, call `provider_tools_list` with an exact name to get the schema and then `provider_call`.

| Tools | Purpose |
| --- | --- |
| `agents_list`, `capabilities_get` | Connected providers, their versions, supported operations and input schemas |
| `sessions_query` | Read-only session list, transcript and status |
| `sessions` | The same reads plus message, steer, stop, create and resume |
| `provider_tools_list`, `provider_call`, `provider_resources`, `provider_prompts` | Native tools, resources and prompts outside the normalized interface |
| `operations_get`, `operations_list`, `operations_cancel` | The caller's durable receipts, and cancellation of undispatched work |
| `events_catalog`, `events_read`, `events_watch`, `events_watch_status`, `events_unwatch` | Event types and provider support, journal replay and exact-session watches |
| `events_follow`, `events_follow_status`, `events_unfollow` | Bounded notifications to another session |
| `questions_present` | Presents a pending provider question to the human through MCP elicitation |

The hub also exposes the resources `switchboard://agents`, `switchboard://events`, `switchboard://event-catalog` and `switchboard://operations/<id>`, and a `coordinate_review` prompt.

### Notify another agent when a job ends

To start a job and have a different session told when it finishes, call `events_watch` before starting it and save the returned `journalCursor`, start the job with a stable request ID, then call `events_follow` with that cursor as `after`. Include `turnId` when the source supplies one, such as the `turnId` in an Antigravity message receipt; otherwise omit it so the follow-up matches the next observed event for that exact session. That order covers a job that finishes before the follow-up exists.

```json
{
  "provider": "antigravity",
  "sessionId": "SOURCE_SESSION_ID",
  "events": ["session.turn.ended", "session.error"],
  "after": 120,
  "turnId": "TURN_ID_FROM_THE_MESSAGE_RECEIPT",
  "notify": { "provider": "codex", "sessionId": "DESTINATION_SESSION_ID" },
  "requestId": "review-job-follow-up-001",
  "maxDeliveries": 1,
  "ttlMs": 3600000
}
```

Before notifying a Codex session, the broker reads its status, so a busy session is steered, an idle one gets a new turn and one in an unrecognized state gets nothing. A Claude Code session always receives a peer message, which it picks up at its next opportunity, and an Antigravity session gets a new turn unless a broker-started turn is still running, in which case the notification is recorded as a failed receipt rather than dropped silently. A follow-up sends one notification by default and at most 100, it expires, and a session cannot subscribe to itself. Events carry metadata such as the session, turn and outcome but never transcript text, and `session.turn.ended` does not imply success, so the recipient still has to inspect the turn. [Session events](docs/events.md) has the full catalog and each provider's semantics.

### Antigravity permission requests

When Antigravity wants to run a tool that needs approval during a turn Switchboard started, it sends an ACP `session/request_permission`. Switchboard never selects an allow option itself. It records the request as a durable question for the client that sent the message, linked to that message's operation, and writes a `question.created` entry to that client's journal, plus a `session.input_required` event if the session is watched. The client then calls `questions_present` with the question ID, which is the entry's `object_id`, which shows you Antigravity's own options through MCP elicitation, and only your choice is passed back. Declining, cancelling, an invalid answer, or no answer within `permissionTimeoutMs` all reject the request once, and stopping the turn answers any pending request as cancelled, as ACP requires. A late answer to an expired request has no effect.

## MCP protocol support

The hub implements the current MCP revision, `2026-07-28`, and still serves clients that open with a legacy `initialize`. Each mechanism below proves something different, and none of them on its own proves that an agent finished anything:

- **Tasks** give a capable client a durable handle to a provider call, with status, cancellation acknowledgment and input-response continuation. A completed task means the provider call returned.
- **Resource subscriptions** signal that `switchboard://events` or an operation changed, and `events_read` replays the journal from a cursor. A notification does not start a model turn.
- **Elicitation** relays a provider's question, such as an Antigravity permission request, to the human through the MCP client, and no tool accepts a model's answer as human authorization. Codex can return `decline` immediately under `approval_policy = "never"`, which is the client's policy speaking, not a human decision.
- **MCP Events** send signed webhooks to verified public HTTPS callbacks, with durable cursors, expiry, bounded retries and key rotation. An acknowledgment proves receipt, not that a model woke up. Local Codex has no webhook callback of its own, so Switchboard can also receive signed events at `/webhooks/<route-id>` and deliver each to one configured session, using the `webhookReceivers` setting described in [local operation](docs/operations.md#receiving-webhooks-for-local-agents).

Any other MCP server can be attached as a passthrough provider by giving it a `url` or a `command` and `args` instead of a `kind`. For a `url`, `tokenFile` supplies its bearer token, or `codexCredential: {file, serverName}` rereads the OAuth credential that Codex stores for that exact server URL on every request; these credentials stay inside the adapter and are never shown to callers. Such a provider has no normalized session operations or session events, but its tools, resources and prompts are reachable through `provider_call`, `provider_resources` and `provider_prompts`, with the same journal, Tasks and form or URL elicitation relay. Set `supportsInputRequired: true` only for a server you have verified against MCP `2026-07-28`.

## Limits

These decide whether Switchboard fits your setup:

- It depends on one Mac. Sleep makes the service unavailable, and desktop work does not move anywhere else.
- The Codex and Claude adapters use local interfaces that those apps do not offer as a public compatibility contract, so an update can break them. The latest versions they were checked against are Codex desktop 26.1021.31345 and Claude Code 2.1.308 in Claude Desktop 3.6556.2. The Antigravity adapter uses ACP, which is a published protocol, and has been checked read-only (initialize, list, history replay) against Antigravity 1.5.15; its prompt, permission, stop and crash handling are covered by tests against a scripted ACP agent.
- Codex discovery examines a bounded window of recent sessions, so an empty list does not prove that none exist. Ordinary Claude Chat and Cowork conversations are out of scope, and Claude Code terminal sessions can be discovered but messaging them has not been verified live.
- Claude's own peer policy can hold or refuse a message, notably from a sender with broader permissions, and Switchboard collects Claude's receipts for only a short window, so a delivered message can still show as `outcome_unknown`. Read the transcript before sending it again.
- Antigravity turns started elsewhere are invisible, a turn that was running when the `agy acp` process or the hub stopped is reported as lost rather than given an invented outcome, and history replay can take a moment for long conversations.
- Switchboard is not an isolation boundary. A caller that can message a session can trigger whatever that session's tools and approvals allow, so use distinct tokens and narrow provider grants, and treat everything peers send as untrusted. Its local checks are not hardened against a hostile process running under the same macOS account.

## Desktop-only server

If all you want is for Codex and Claude Code to reach each other, the original stdio server is still available as `node server.mjs`. It needs no hub, tokens or installed packages and offers seven tools: `codex_list`, `codex_owner`, `codex_read`, `codex_send`, `claude_list`, `claude_read` and `claude_send`. It has none of the durable receipts, events or Antigravity support described above. The [legacy guide](docs/desktop-legacy.md) has the registration commands.

## Development

```sh
npm run check
npm test
npm run test:live
```

`npm run check` syntax-checks the sources. `npm test` uses controlled services, temporary databases and sockets, and a scripted ACP agent in `test/fixtures/fake-acp.mjs`, so it does not message your running agents. `npm run test:live` runs read-only probes against a configured service and writes private reports to the ignored `evidence/live/` directory. Mutations need a reviewed plan, dedicated fixtures and `--allow-mutations`, as the [live matrix](docs/live-matrix.md) describes.

## Documentation

- [Architecture](docs/architecture.md): adapter wire formats, the trust model and failure handling
- [Local operation](docs/operations.md): restarts, remote clients, discovery freshness, webhook receivers and elicitation
- [Session events](docs/events.md): the event catalog and each provider's semantics
- [Protocol compatibility](docs/protocols.md): how Tasks, subscriptions, Events and elicitation differ
- [Live matrix runbook](docs/live-matrix.md)
- [Legacy desktop-only server](docs/desktop-legacy.md)

## Project background

- [Agent Switchboard project overview](https://chabot.dev/projects/#agent-switchboard) on Chris Chabot’s site.

## License

[MIT](LICENSE), copyright 2026 Chris Chabot. Switchboard is built on the Model Context Protocol SDK packages under `@modelcontextprotocol` and on Ajv.
