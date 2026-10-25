# Live acceptance matrix

Observed on October 24–25, 2026, using dedicated fixtures. `Pass` means the
operation was exercised through Switchboard; native completion evidence is
qualified below. `Unsupported` is an explicit connector capability limit.

| Operation | Codex desktop | Claude Code | Fabric | Maestro |
| --- | --- | --- | --- | --- |
| Session list, read, status | Pass | Pass | Pass | Pass |
| Session search | Unsupported | Unsupported | Pass | Pass |
| Session create | Unsupported | Unsupported | Pass | Pass |
| Session message | Pass | Pass | Pass | Pass |
| Active-turn steer | Pass | Unsupported | Pass | Pass |
| Stop | Pass | Unsupported | Pass | Pass |
| Resume | Unsupported¹ | Unsupported | Pass | Pass |
| Session rename | Unsupported | Unsupported | Unsupported | Pass |
| Session archive, restore | Unsupported | Unsupported | Pass | Pass |
| Session deletion preview, delete | Unsupported | Unsupported | Pass | Pass |
| Project list, read | Unsupported | Unsupported | Pass | Pass |
| Project search | Unsupported | Unsupported | Unsupported | Pass |
| Project create, update | Unsupported | Unsupported | Pass | Pass |
| Project archive, restore | Unsupported | Unsupported | Pass | Pass |
| Project deletion preview, delete | Unsupported | Unsupported | Pass | Pass |

¹ Codex same-thread continuation through messaging passes; the connector does
not expose a separate native resume operation. Fixture creation through the
Codex host UI does not establish peer-session creation support.

Codex interruption and Fabric cancellation are confirmed in native turn state;
later continuations complete with expected output. Stopping a turn does not
guarantee termination of a previously launched command. Maestro stop and resume
receipts preserve their native scope, and the suite does not reinterpret a
ready indicator as proof that an active agent was interrupted. Fabric project
restore returns to paused without restarting project work. Session deletion
uses the native undo window; acceptance of deletion is not immediate purge.

Every originating agent has called every provider's status tool: 16 of 16
routes pass in actual native tool records. This is a read-route matrix, not a
claim that every possible mutation has been issued from all four origins.
The full four-agent execution chain separately verifies peer delivery and
automatic completion notifications. Native permissions remain in force,
including Claude's hold on messages from a sender with broader permissions.

| Protocol journey | Evidence |
| --- | --- |
| Hub Tasks and resource invalidation | Live pass |
| Native Maestro Tasks and bounded watch cancellation | Live pass |
| Native Fabric Tasks, event wait and task resources | Live pass |
| Codex, Claude, Maestro and Fabric terminal events | Live pass |
| Four-agent completion notification chain | Live pass; three one-shot deliveries and four agent acknowledgments |
| Error and completed-block notifications | Live pass; one delivery each and native Fabric completion |
| Public signed MCP Events callback | Live pass; challenge and three distinct signed events |
| Human elicitation decline/cancel preservation | Live client decline; automated accept/cancel contract tests pass |
| Positive human answer through this Codex host | Native form visibly renders with On request permissions; human submission remains pending after two presentation timeouts |
| Signed webhook causing a host model to run | Live pass: Fabric turn end → public signed HTTPS webhook → durable receiver → native Codex completed turn and matching event ID; replay reuses the original operation |

The native escape hatch exposes the providers' larger catalogs, including
administrative and account tools. Their schemas are discoverable, but presence
in the catalog is not acceptance of every tool. The read-only matrix retains
these unrun cells. Private receipts and transcripts stay in ignored
`evidence/live/`; public documentation contains no fixture identities.
