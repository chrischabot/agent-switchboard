# Four-agent Switchboard implementation

Owner authorization: implement, run locally, connect Codex, Claude Code, Fabric
and Maestro, and verify the full supported interaction matrix (24 October 2026).

## Execution order

1. Build the persistent broker, provider registry, operation journal and authenticated
   local MCP endpoint. Keep existing seven desktop tools compatible.
2. Connect the existing desktop IPC, Maestro broker and Fabric Tutti MCP. Preserve
   provider-specific tools alongside normalized session/project operations.
3. Implement current MCP discovery, resources/subscriptions, Tasks and elicitation,
   with explicit legacy compatibility. Add native support to the owned upstream
   adapters and Fabric client where the host can use it.
4. Install the local service and client connections. Use dedicated test sessions;
   do not restart ordinary paused projects or interrupt unrelated work.
5. Run contract, persistence, security and live lifecycle tests, then all 16 caller
   to target routes and the four-provider round trip. Record exact evidence and
   unsupported capabilities. Review, commit and push completed changes on main.

## Acceptance rules

- A successful write is not completed agent work. Record dispatch, receipt and
  execution separately, preserving unknown outcomes across process restart.
- Stable caller request IDs deduplicate mutations. Changed arguments with the
  same ID are conflicts. Never retry an uncertain non-idempotent provider write.
- Capability records distinguish implementation, availability, semantics and
  current-version live verification. Native app-internal functions do not become
  supported merely because this chat can invoke a host tool.
- List/read results are bounded and paginated; subscriptions invalidate resources,
  while durable journal cursors provide replay. An SSE acknowledgement is not
  evidence that a session event reached a model.
- Every live test owns exact recorded fixture IDs. Deletes, interrupts and
  fault injection are limited to those fixtures. Native approval, spending and
  authorization checks remain in force.
- Existing desktop conversations stay desktop-owned. Any separately managed CLI
  runtime must have a distinct identity and cannot satisfy desktop acceptance.

## Current evidence and limitations

Codex desktop 26.1021.31345 has working owner discovery and follower IPC; create
and archive are not exposed by the inspected peer protocol. Claude Desktop
3.6556.2 owns Claude Code 2.1.308 workers with peer inboxes; its broader lifecycle
API is app-internal Electron IPC. These gaps require a proven connector or an
explicitly labeled delegated host path, never fabricated native support.

The implementation stays in the existing JavaScript ESM package, with the
current maintained MCP SDK. Node's built-in SQLite supplies durable local state.
SDK 2.3.1 is pinned because 2.4.0 is newer than this machine's package-age policy.
No package-age or application permission policy is weakened.

## Matrix ledger

The live runner writes a local JSON report with one cell per provider/operation
and ordered caller/target pair. Cells are `live_pass`, `live_fail`,
`implemented_unverified`, `unsupported`, `blocked` or `not_run`; each includes
runtime version, timestamps and evidence. Full acceptance requires every
supported requested cell to pass. No fixture test is counted as live evidence.
