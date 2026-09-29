---
"@vibeflow-tools/cli": minor
---

**The MCP server is stable as of this release.** It was marked experimental in 0.12.0; the warnings
that described it that way are gone, and the CLI help, the JSON-RPC error envelope and the tool
manifests all describe a supported surface.

What the release actually delivers on that promise, beyond the bug fixes listed alongside it:

- **One project root per server, resolved and announced at startup.** The stdio transport requires
  `--project <dir>` — the spawn cwd belongs to the MCP client and is never trusted — and the root is
  resolved and validated once, with the absolute path, project name and git branch announced before
  any tool runs. The read-only `get_project` tool returns the same facts, so a client can ask what it
  is attached to without guessing.
- **Every refusal carries a code and a recovery hint.** A failing tool answers the CLI's own
  `{ok:false, error:{code, message, retryable, suggestion?}}` envelope, so one parser reads both
  surfaces. One code carries one suggestion wherever it appears, and the shared review-gate
  suggestions name both the MCP input and the CLI flag, so a client is never handed an instruction
  (`--report-file`) that does not exist on its surface. Three tools that used to report success for a
  task that was not there — `add_comment`, `attach_file`, and a link naming a missing task — now
  refuse with `TASK_NOT_FOUND` and write nothing.
- **`dryRun` is a real preview.** Every mutating tool honours it from the tool input, not only from
  the transport, and a preview answers with a `notices` array carrying `{code:"DRY_RUN", …}` so a
  client can never read a dry run as a write that happened. A preview and the real call now agree on
  refusals too.
- **Success payloads say what did not happen.** The non-fatal signal is one `notices` array of
  `{code, message}` — the same name and shape the CLI's `--json` uses — carrying `DRY_RUN`,
  `GIT_COMMITTED` and `GIT_COMMIT_FAILED`, so a failed auto-commit after a review transition is
  reported instead of silently dropped.
