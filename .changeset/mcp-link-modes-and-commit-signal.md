---
"@vibeflow-tools/cli": patch
---

Add `addLinks` / `removeLinks` to `update_task`, so changing links no longer
requires a destructive whole-set replace.

`links` keeps its replace semantics (HTTP PATCH parity) — the array becomes the
full link set, an empty array clears everything, and **any link you omit is
deleted**. Omitting the field leaves links untouched. That made the only way to
add one link an easy way to destroy another: adding a `blocks` link to a task
that had a `parent` silently detached the task from its parent, with no error.
`addLinks` (merge, idempotent, preserves everything it does not name) and
`removeLinks` (removes exactly the named `taskId`+`type` pairs) mirror the
CLI's surgical `--set-parent` / `--no-parent`, which never dropped unrelated
links. `links` combined with either is refused `E_USAGE` rather than guessed.
`relates` and `blocks` remain reachable on both surfaces.

Surface an error-class notice at the top level. A task transition whose git
auto-commit fails still answers `ok:true`, correctly — the task file was
written and the status really changed; only the commit did not. But `notices`
is where that failure lived, and a client checking one scalar never saw it.
`successPayload` now also emits `committed: false` when a notice is
error-class (`GIT_COMMIT_FAILED` today; informational codes such as
`DRY_RUN`, `GIT_COMMITTED`, `PUSH_COMPLETED` and `NOTHING_TO_PUSH` are
excluded). Purely additive: `ok`, `notices` and every existing payload shape
are unchanged, and the key is omitted entirely when there is nothing to report.

`update_task`'s tool description now states the deletion hazard explicitly and
maps `links` / `addLinks` / `removeLinks` to their CLI counterparts.

Covered by `mcp-link-modes.test.ts` (14 cases over the real HTTP MCP
transport, asserting on-disk links rather than the return value), plus
`success-payload-committed.test.ts` and `task-links.test.ts`.