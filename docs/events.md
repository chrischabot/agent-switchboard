# Session event subscriptions

Use `events_catalog` to discover event names and each connected provider's
support. The catalog is also a resource at `switchboard://event-catalog` and
appears in MCP `events/list`. A declared event source requires its own live
acceptance; a successful webhook request does not establish model activity.

The following table defines the event types:

| Event | Meaning |
| --- | --- |
| `session.turn.started` | The source reports a turn start. |
| `session.turn.ended` | The source reports a terminal turn boundary. Inspect `outcome`; the turn can fail or be canceled. |
| `session.error` | A source reports an error. `scope` distinguishes a tool or block failure from a turn failure. |
| `session.block.created` | An output or tool block starts. |
| `session.block.updated` | A block changes. This can produce many events. |
| `session.block.completed` | A visible output or tool block completes. |
| `session.input_required` | The source reports an ask or approval request. The event does not answer it. |
| `session.state.changed` | A native session state changes. A ready or paused state does not establish turn completion. |
| `session.source.gap` | Observation or replay is incomplete. Reconcile native state before continuing dependent work. |
| `operation.changed` | A broker dispatch receipt changes. This event does not establish agent completion. |

Events carry bounded metadata: provider, session, source identity, scope, and
available turn, block, state, or outcome fields. They omit transcript bodies,
reasoning, output text, tool arguments, and credentials. Use the provider's
read-only query tools when you need those results and have access.

## Observe a session

Call `events_watch` with an exact provider and session ID:

```json
{
  "provider": "codex",
  "sessionId": "SESSION_ID",
  "ttlMs": 3600000
}
```

Replace `SESSION_ID` with the ID returned by that provider. The response returns
a watch identity and journal cursor. Read `events_read` after that cursor, or
subscribe to the `switchboard://events` resource for invalidations. Read
`events_watch_status` to inspect a watch without restarting it. Call
`events_unwatch` to stop the observation source; it does not stop the agent.

A watch starts at the live boundary. A restored watch resumes its saved source
cursor. Source gaps remain visible after a restart. A caller can hold at most
32 watches, each with a lifetime of one second to seven days.

## Request a follow-up

For "start this job and notify another agent when it ends," use the following
sequence to cover a job that finishes before you create the follow-up:

1. Call `events_watch` before starting the job. Save its `journalCursor`.
2. Start the job with a stable mutation request ID. Save the accepted native
   turn ID when the provider supplies one.
3. Call `events_follow` with the saved cursor and exact turn ID.

The following example requests one notification:

```json
{
  "provider": "fabric",
  "sessionId": "SOURCE_SESSION_ID",
  "events": ["session.turn.ended", "session.error"],
  "after": 120,
  "turnId": "ACCEPTED_TURN_ID",
  "notify": {
    "provider": "codex",
    "sessionId": "DESTINATION_SESSION_ID"
  },
  "requestId": "review-job-follow-up-001",
  "maxDeliveries": 1,
  "ttlMs": 3600000
}
```

Replace each placeholder with an exact native identifier. Set `after` to the
saved caller-journal cursor. If the source does not supply a turn ID, omit
`turnId`; the subscription then matches the next observed event for that exact
session, including replay after the supplied cursor.

To receive each completed block, subscribe to `session.block.completed` and set
an explicit `maxDeliveries`. The default is one notification, and the maximum
is 100. Follow-ups have a finite lifetime. The broker refuses a session's
subscription to its own follow-up messages.

Read `events_follow_status` to inspect delivery attempts and the operation
receipt. Call `events_unfollow` to cancel future notifications. An already
accepted notification remains subject to its native receipt and approval state.
A dispatched peer message does not establish that a model consumed it. The
recipient keeps its own permissions and native approval controls.

## Subscribe through MCP Events

For clients that support signed webhook delivery, call `events/subscribe` with
an event name, exact source filters, a public HTTPS callback, and the receiver's
secret. The receiver must verify signed requests and echo the signed
subscription challenge. Each event name has a separate stable subscription
identity. You can filter session events by `provider`, `sessionId`, and optional
`turnId`.

Webhook acknowledgment advances the durable subscription cursor. The sender
reuses the same event ID after an uncertain delivery. Deduplicate that event ID
at the receiver. Refresh subscriptions before expiry and handle replay gaps.
See [local operation](operations.md) for transport and restart behavior.

## Provider semantics

The following table describes each observation source:

| Provider | Source and limits |
| --- | --- |
| Codex desktop | File-change notifications for the exact native rollout. Explicit task boundaries produce turn events; completed item records produce block events. Observation can lag generation. A failed command inside a completed turn remains a block-scoped error. |
| Claude Code in Desktop | File-change notifications for the exact session transcript. Visible assistant blocks use response and block identities. An `end_turn` marker alone does not end a turn; the adapter waits for the final stop-hook boundary. A hook that prevents continuation clears the pending terminal response. |
| Fabric | Tutti `thread_events_wait`, backed by a caller-scoped Fabric stream. Repeated waits reuse a stream rather than polling status. Requires the tool in the connected runtime's catalog. Condensed legacy replay cannot supply full block bodies or infer outcomes from clipped previews. |
| Maestro | Native broker event journal and event-driven waits. Optimistic `task_end` and `ready` signals do not complete turns. Persisted turn summaries retain their native outcome. Broker observer history is not a complete upstream replay; disconnects and generation changes expose gaps. |

Unsupported provider-event combinations remain explicit in `events_catalog`.
Token deltas, periodic model prompts, and inferred project completion are not
part of these event contracts.
