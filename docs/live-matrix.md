# Live acceptance matrix

See [observed acceptance](acceptance-matrix.md) for the supported lifecycle
surface, real agent routes, protocol results and remaining host limitations.

Run the harness from the Switchboard checkout:

```bash
node test/live/matrix.mjs
```

It connects through `bin/call.mjs` and the private local configuration selected
by `SWITCHBOARD_CONFIG`. It writes a new owner-readable JSON file under
`evidence/live/`, which is excluded from Git. It never overwrites an earlier
report. The command prints the report path and status counts.

The default run is read-only. It performs hub discovery, catalogs, prompt
rendering, resource reading, provider capability inspection, bounded native
session/project lists and searches, and exact fixture status/transcript reads.
Provider prompt and resource catalogs are queried when advertised. No prompt
is executed. Missing fixtures produce blocked cells; the runner never adopts
a session returned by a list as a test fixture.

```bash
node test/live/matrix.mjs --fixtures evidence/live/fixtures.json \
  --out evidence/live/matrix-reviewed-run.json
node --test test/live/matrix.test.mjs
```

`--no-routes` omits caller-token route probes while retaining all sixteen route
cells as `not_run`. Use it for a shorter operator-only inspection.

## What the report establishes

Each provider has a cell for every declared normalized operation, including
creation, messaging, stop, resume, archive, restore and deletion. Each native
tool also has an explicit ledger entry. Catalog presence does not establish
functional acceptance: native tools that were not individually exercised remain
`not_run`. Runtime versions and registry observation timestamps are recorded
separately from each probe timestamp.

All sixteen ordered caller-to-target routes have two separate cells:

- `harness`: the caller's configured bearer credential reads the target's
  capabilities and invokes its native session list through Switchboard.
- `originatingAgent`: remains `not_run`. A successful request signed with the
  Codex credential is not evidence that Codex itself called the tool, consumed
  a notification, resumed a thread, or completed a review.

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

## Signed public webhook proof

`test/live/webhook-proof.mjs` runs an explicit live receiver test. Configure an
owned public HTTPS path to forward to its loopback port before running it:

```sh
SWITCHBOARD_TEST_CALLBACK_BASE=https://callback.example/events-test \
SWITCHBOARD_TEST_CALLBACK_PORT=8797 \
  node test/live/webhook-proof.mjs UNIQUE_STABLE_RUN_KEY
```

The receiver checks the signature, timestamp and event identity, echoes the
signed challenge, and observes a rename of the exact recorded Maestro test
fixture. It starts no inference. The report records receipt evidence without
credentials or transcript bodies. The script unsubscribes and closes its
receiver on exit. The operator owns temporary ingress setup and must restore
that configuration after the test. Never use another application's default
tunnel configuration. A public delivery proof does not establish client model
wakeup.

## Live Tasks and resource notifications

Run the protocol proof against the configured hub and Maestro broker:

```sh
node test/live/protocol-proof.mjs UNIQUE_STABLE_RUN_KEY
```

This test uses the exact owned Maestro fixture. It verifies a real resource
invalidation, hub task creation and result retrieval, and native Maestro task
completion. It also verifies the provider's cancellation semantics: an
acknowledgment preserves a running native read until the read completes. It
renames the test fixture to its test name and starts no inference. Reports
remain under the ignored evidence directory.

## Native Fabric Tasks and event-wait protocol

After the running Tutti catalog includes `thread_list` and `thread_events_wait`,
run the Fabric proof with an exact owned fixture registry:

```sh
node test/live/fabric-protocol-proof.mjs UNIQUE_STABLE_RUN_KEY \
  evidence/live/fabric-protocol-fixture.json
```

The registry uses the `fabric` shape below and must identify a manual test
project. The proof checks immediate passive reads, bounded native thread
listing, an event-stream cursor, native Task completion, cancellation of an
already completed Task, and its private resource representation. Its only
write submits the project's existing brief goal with a stable native
idempotency key. It starts no model turn or project work. A separate live
session journey must establish actual event production and agent notification.
The proof preserves its Task identity before waiting and refuses to overwrite
an existing report. Inspect an unresolved native operation before retrying.

## Fixture registry

The existing private `evidence/live/fixtures.json` contains the dedicated Codex
and Claude desktop session IDs. Fabric and Maestro fixture IDs can be added
only after those disposable native objects have actually been created and
verified. Preserve the existing records when adding entries.

```json
{
  "codex": {
    "id": "actual-recorded-session-id",
    "purpose": "Switchboard dedicated live E2E",
    "createdVia": "Verified native host creation"
  },
  "fabric": {
    "id": "actual-recorded-thread-id",
    "projectId": "actual-recorded-project-id",
    "purpose": "Switchboard dedicated live E2E"
  }
}
```

The runner uses only exact `id` and optional `projectId` records for targeted
reads. It never creates fixtures automatically.

## Explicit fixture mutations

The mutation runner accepts only session rename, stop, archive, restore,
deletion preview and deletion. It requires both an explicit plan and
`--allow-mutations`, the exact recorded session ID, the ownership marker shown
above, and a stable `--run-key`. Stop requires an exact current turn ID for
Codex and Fabric. Delete requires the reviewed native confirmation token.
Unknown input fields, nested targets and caller-supplied request IDs are refused.

Creation, messaging, steering, resume and project updates are deliberately
excluded from automation because they can start inference. Their matrix cells
remain visible for separately authorized manual client acceptance. The harness
does not automatically perform paid model work.

A reviewed local plan has this shape; replace the ID with the existing fixture
ID, and do not commit the plan:

```json
[
  {
    "provider": "codex",
    "operation": "sessions.rename",
    "input": { "id": "actual-recorded-session-id", "name": "Switchboard fixture" }
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

The four-agent chain has a separate read-only verifier:

```bash
node test/live/chain-proof.mjs chain-RUN_KEY
```

Before executing the chain, prepare exact owned fixtures and save the caller's
starting journal cursor. Arm one-shot follows from Claude to Maestro, Maestro
to Fabric, and Fabric to Codex. Start Claude through the authorized Codex
fixture's native MCP connection so its real sender permission context is used.
Do not change recipient permissions to make a test pass.

The private `chain-RUN_KEY.json` records `startedAt`, `after`, the fixture
registry, expected acknowledgment strings keyed by provider, and the three
follow identities. Capture the journal as `chain-RUN_KEY-events.json`, bounded
native reads as `chain-RUN_KEY-{claude,codex,fabric}-read.json`, and Maestro's
native conversation artifact as `chain-RUN_KEY-maestro-native.json`.
The verifier reads current follow receipts, checks recorded terminal ordering
and native assistant acknowledgments, and writes a metadata-only proof with an
evidence digest. It never starts work or retries delivery to fill missing proof.
Unwatch the test sources after capture; completed follow identities remain for
idempotency and audit.

Read-only matrix reports contain timestamps, durations, counts, runtime metadata, stable request
IDs, receipt IDs and SHA-256 hashes. Raw transcripts, prompts, provider results,
credentials and raw error messages are not persisted in those reports. The
separate, explicitly captured chain artifacts above remain private and ignored.
Each matrix input file is limited
to 1 MiB, each report to 2 MiB, and plans to 24 operations. Reports are created
with mode `0600` inside directories created with mode `0700`.

The focused test suite uses a controlled RPC boundary to verify harness logic;
those tests are never entered into the live ledger as acceptance evidence.
The production broker, native protocol tests and actual originating-agent
journeys have separate evidence.
