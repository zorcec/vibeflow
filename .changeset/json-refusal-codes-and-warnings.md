---
"@vibeflow-tools/cli": patch
---

Every `--json` refusal now carries its error code, and a partial success is a warning.

**Refusals.** Re-deriving the `process.exitCode` sites in `src/index.ts` found 32 that printed chalk
prose and never consulted `opts.json`, so a machine consumer saw empty stdout, no code and nothing to
branch on. All of them now write the standard `{ok:false, error:{code, message, retryable,
suggestion?}}` envelope to **stderr** with stdout left clean, and `tests/e2e/tasks-json-refusals.test.ts`
asserts exit code, empty stdout and the assigned code for each path (the code, not just the shape).
Human output is unchanged. Codes follow one rule: `E_USAGE` for a bad flag value or an impossible
combination, `TASK_NOT_FOUND` for a task or parent that does not exist (the two local sites that
emitted `E_NOT_FOUND` for a task are migrated so CLI and MCP agree), `E_NOT_FOUND` for a missing
file such as `--report-file`, and for the online board two **new** codes —
`E_BACKEND_UNAVAILABLE` (`retryable: true` only when the host was unreachable) and
`E_NOT_AUTHENTICATED` (session expired, not retryable). `buildSetParentLinks` now returns the code it
refused with, so the parent-link refusals no longer re-derive one from the human reason string.

**Partial success.** A refusal is for "nothing happened"; a warning is for "the task data was saved
but a follow-on step did not complete". The auto-commit that follows a review transition and the
`--reindex-sort-keys` post-assert now keep `ok:true` and **exit 0**, and the success payload gains an
optional `warning: {code, message}` — `GIT_COMMIT_FAILED` and `REINDEX_INCOMPLETE`. The key is
absent on a clean run, so consumers parsing the success payload are unaffected. A comment-save
failure stays a refusal (`E_COMMENT_SAVE`, non-zero exit): the comment is part of the task data, so
the task is genuinely incomplete.

**Breaking:** the auto-commit-failed path exits 0 instead of 1. It signalled a failure for work that
had already landed, which told a consumer to retry an edit that applied. Scripts that chained
`tasks --edit … && git push` will no longer stop there; both modes now say why in the warning.

Also fixed on the way: `commitTaskPaths`/`commitTaskChanges` let git write to the CLI's own stderr,
putting a git usage dump in front of the envelope; git's stderr is now captured and folded into the
error message, so stderr parses as JSON. A new unit test
(`tests/unit/json-refusal-guard.test.ts`) re-derives every non-zero exit site structurally — no
line numbers — and fails if one stops consulting the json surface, with a single allowlisted
exception (`reportProjectRootFailure`, whose only callers `serve`/`kanban`/`mcp` define no `--json`).
