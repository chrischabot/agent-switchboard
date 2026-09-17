# Verification

This record separates historical live acceptance from local automated tests.
It omits private task names, transcript content, process IDs, and session IDs.

## Live desktop acceptance

On September 11, 2026, the original implementation connected an existing Codex
desktop task and an existing Claude Code 2.1.260 desktop session on macOS. It
started no replacement model processes, restarted neither application, and
changed no recipient permissions or project files.

The following checks passed:

- Discovery of a live owner for the Codex task and a live registered Claude
  Code session.
- Recent conversation reads from both sessions.
- A message from the Codex-side stdio MCP diagnostic client to Claude, followed
  by Claude calling its installed `codex_list`, `claude_list`, `codex_read`, and
  `codex_send` tools. The acknowledgment arrived in the existing Codex task.
- A second exchange after the Claude desktop interface showed the same session
  as idle, with its reply reaching the existing Codex task again.
- A negative sender-context probe that returned a policy hold. Supplying the
  originating Codex task's verified context resolved the missing-metadata
  failure without changing the recipient's approval settings.

These tests used the predecessor MCP name before the Switchboard rename. The
private evidence remains with the original development record and is not part
of this public repository.

## Local tests

The extraction on September 17, 2026, passed seven tests on Node.js 26.8.2.
The suite covers UTF-8 frame lengths, exact-target validation, fragmented IPC
responses, server errors, MCP initialization and tool discovery, private Claude
socket authentication, receipt correlation and cleanup, and sender-context
handling. The MCP handshake test checks the renamed `agent-switchboard`
identity.

Run `npm test` to repeat these checks. They use fixture sessions and sockets;
passing them does not establish compatibility with running applications.

## Unverified or unsupported paths

Independent terminal sessions, the Codex idle `start` operation, and Codex's
in-session MCP catalog reload require separate live acceptance. Session
creation, cancellation, a Codex terminal adapter, and durable receipts are not
implemented. Ordinary Claude Chat and Cowork conversations are unsupported.

For a live acceptance check, choose a session whose owner has agreed to the
test, send a unique acknowledgment request, and verify its arrival and reply
in both conversations. Check policy receipts as well as transcript evidence.
Do not infer success from a completed socket write or retry an uncertain write
without checking whether it arrived.
