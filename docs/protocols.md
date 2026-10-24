# Protocol and host compatibility

MCP Events, Tasks, resource subscriptions and elicitation solve different
problems. Switchboard implements them independently and checks each caller's
declared capabilities before returning an extension result.

| Mechanism | Purpose in Switchboard | Completion evidence |
| --- | --- | --- |
| MCP Tasks | Retain a handle to a provider call that continues after acceptance. | The provider call returns; native agent work can continue. |
| Resource subscriptions | Invalidate a caller's journal or operation view. | The subscriber receives an invalidation and reads the updated view. |
| MCP Events | Deliver filtered events to a verified, signed HTTPS callback. | The receiver acknowledges delivery; model execution needs separate evidence. |
| Elicitation | Relay a native question to a capable human-facing client. | The actual response returns through the original continuation. |

The current core revision is `2026-07-28`; Tasks is an optional extension with
durable handles and mid-flight input. Both sides must support the extension.
See the [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28).

OpenAI's MCP Events integration uses webhook delivery and callback verification.
Its documented receiving surfaces are Work chats on the web, desktop Work chats
with Cloud selected, and dots. This does not establish webhook wakeup for a
local Codex task. See [OpenAI's MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events).

Claude Code documents server-side Tasks separately from unsolicited channels.
On a `2026-07-28` connection, a server returns a task only when that request
declares the Tasks extension. Elicitation supports forms and URL flows. See
[Claude Code's Tasks guidance](https://code.claude.com/docs/en/mcp#mcp-tasks-for-server-authors)
and [elicitation guidance](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests).

## Routing decision

The initial implementation uses native desktop IPC for local task wakeup and
native provider tools for Fabric and Maestro. A signed webhook receiver is an
additional capability, not a prerequisite for those routes. The registry keeps
unsupported desktop lifecycle methods explicit rather than silently replacing
their sessions with new CLI workers.

Modern stdio requests retain their wire messages. A legacy `initialize` opening
uses a persistent SDK connection that preserves declared client capabilities
and relays elicitation continuations. A legacy client without elicitation
support receives a refusal. Legacy resource subscriptions remain unadvertised;
modern subscription streams are verified separately.

Capability discovery and live acceptance remain separate. See
[verification](verification.md) for the observed four-agent matrix and
[session events](events.md) for exact native event meanings and source limits.
