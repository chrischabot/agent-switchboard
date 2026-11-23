# Live acceptance matrix

The live matrix checks a running Switchboard against your real agents without
starting any model work. Run it from the checkout:

```bash
node test/live/matrix.mjs
```

It connects through `bin/call.mjs` and the private local configuration selected
by `SWITCHBOARD_CONFIG`. It writes a new owner-readable JSON file under
`evidence/live/`, which is excluded from Git. It never overwrites an earlier
report. The command prints the report path and status counts.

The default run is read-only. It performs hub discovery, catalogs, prompt
rendering, resource reading, provider capability inspection, bounded session
lists, and exact fixture status and transcript reads. Provider prompt and
resource catalogs are queried when advertised. No prompt is executed. Missing
fixtures produce blocked cells; the runner never adopts a session returned by a
list as a test fixture. For Antigravity, a transcript read replays the fixture
conversation's history through `session/load` in the broker's process, which
does not change the conversation.

```bash
node test/live/matrix.mjs --fixtures evidence/live/fixtures.json \
  --out evidence/live/matrix-reviewed-run.json
node --test test/live/matrix.test.mjs
```

`--no-routes` omits caller-token route probes while retaining all nine route
cells as `not_run`. Use it for a shorter operator-only inspection.

## What the report establishes

Each provider has a cell for every normalized session operation: list, read,
status, create, message, steer, stop and resume. Each native tool also has an
explicit ledger entry. Catalog presence does not establish functional
acceptance: native tools that were not individually exercised remain
`not_run`. Runtime versions and registry observation timestamps are recorded
separately from each probe timestamp.

All nine ordered caller-to-target routes between `codex`, `claude` and
`antigravity` have two separate cells:

- `harness`: the caller's configured bearer credential reads the target's
  capabilities and invokes its native session list through Switchboard.
- `originatingAgent`: remains `not_run`. A successful request signed with the
  Codex credential is not evidence that Codex itself called the tool, consumed
  a notification, resumed a thread, or completed a review.

A route whose caller has no configured client, such as `antigravity` when the
shim is not registered in Antigravity, is recorded as blocked.

Protocol cells cover discovery, catalogs, prompts, resources, subscriptions,
Tasks, elicitation and webhook delivery. Features that need a genuine client
journey or a mutation remain untested. In particular, listing a resource does
not establish notification delivery, and an SSE acknowledgment does not establish
that a model received an event.

Statuses mean:

| Status | Meaning |
| --- | --- |
| `live_pass` | The stated probe succeeded against the running service. Read its evidence scope. |
| `live_fail` | The attempted probe returned an application/protocol failure. |
| `unsupported` | The available capability declaration excludes this operation. |
| `blocked` | Access, availability, an exact fixture or a settled receipt is missing. |
| `not_run` | The feature exists or is required, but this run did not exercise it. |

An offline provider's empty catalog is recorded as blocked rather than proof
that its operations do not exist. A completed provider-call receipt is not proof
that native agent work finished. The report does not declare overall completion
while supported operations or originating-agent cells remain unverified.

Result classification inspects each MCP and hub envelope before unwrapping it.
A nested native `isError`, structured error or failed receipt remains a failure,
even when the outer dispatch succeeded. A later successful receipt read cannot
erase a native rejection already observed during the same run. Raw error text
is still excluded from the report.

## Fixture registry

Record one dedicated, disposable session per provider in the private
`evidence/live/fixtures.json`. Create these sessions yourself; the runner never
creates fixtures.

```json
{
  "codex": {
    "id": "actual-recorded-session-id",
    "purpose": "Switchboard dedicated live E2E"
  },
  "antigravity": {
    "id": "actual-recorded-session-id",
    "purpose": "Switchboard dedicated live E2E"
  }
}
```

The runner uses only these exact `id` records for targeted reads.

## Explicit fixture mutations

The only automated mutation is `sessions.stop`, because it starts no model
work. It requires both an explicit plan and `--allow-mutations`, the exact
recorded session ID, the ownership marker shown above, a stable `--run-key` and
the fixture's current exact turn ID. Unknown input fields, nested targets and
caller-supplied request IDs are refused.

Creation, messaging, steering and resume are deliberately excluded from
automation because they can start inference or change which process holds a
session. Their matrix cells remain visible for separately authorized manual
client acceptance. The harness does not automatically perform paid model work.

A reviewed local plan has this shape; replace the IDs with the fixture's, and do
not commit the plan:

```json
[
  {
    "provider": "codex",
    "operation": "sessions.stop",
    "input": { "id": "actual-recorded-session-id", "expectedTurnId": "current-turn-id" }
  }
]
```

```bash
node test/live/matrix.mjs --mutations evidence/live/reviewed-plan.json \
  --allow-mutations --run-key reviewed-fixture-run-1
```

The provider capability declaration still controls whether a planned operation
is available. The runner sends an allowed mutation once and reads its receipt
once. It does not retry an uncertain write or wait in a polling loop. Repeat
the same logical run key when reconciling the same intent: the stable request
ID remains identical, and changed arguments produce a broker conflict rather
than a second logical mutation. A pending or unknown receipt remains blocked.

## Evidence and privacy

Matrix reports contain timestamps, durations, counts, runtime metadata, stable
request IDs, receipt IDs and SHA-256 hashes. Raw transcripts, prompts, provider
results, credentials and raw error messages are not persisted. Each input file
is limited to 1 MiB, each report to 2 MiB, and plans to 24 operations. Reports
are created with mode `0600` inside directories created with mode `0700`.

The focused test suite uses a controlled RPC boundary to verify harness logic;
those tests are never entered into the live ledger as acceptance evidence.
