---
"@vibeflow-tools/cli": minor
---

Add a read-only MCP `get_project` tool (10 → 11 tools).

An agent can now ask what project the server is attached to before touching anything: the tool returns the resolved absolute root, project name, current git branch and mode (`local`/`saas`). It takes no input — the root is resolved once at server startup and is never a per-call parameter, so the tool can only *discover* the project the server already runs in, never retarget it. Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

Mapping: `cliRef` points at the hidden `vibeflow status` command (no options, hence `flags: []`), whose local-mode output now prints the resolved project root and git branch alongside the task statistics, so the CLI surface actually shows what the tool returns.
