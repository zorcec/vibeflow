---
"@vibeflow-tools/cli": patch
---

Every `--json` refusal now carries its error code, and a partial success is a notice.

**Refusals.** Re-deriving the `process.exitCode` sites in `src/index.ts` found 32 that printed chalk
prose and never consulted `opts.json`, so a machine consumer saw empty stdout, no code and nothing to
branch on. All of them now write the standard `{ok:false, error:{code, message, retryable,
suggestion?}}` envelope to **stderr** with stdout left clean, and `tests/e2e/tasks-json-refusals.test.ts`
asserts exit code, empty stdout and the assigned code for each path (the code, not just the shape).
Human output is unchanged. `buildSetParentLinks` now returns the code it refused with, so the parent-link
refusals no longer re-derive one from the human reason string.

One new code: **`REINDEX_WRITE_FAILED`**. `--reindex-sort-keys` decided its whole outcome from the
post-assert alone, on the assumption that a planned re-keying always lands. It does not —
`writeSortKeyMinimal` can compute a patch and then decline to write it (a task file with neither a
`sortKey` nor an `updated` field has nothing to edit in place), and the suite's own fixture hit that
path. So a run that wrote NONE of its planned keys claimed `ok:true` and exit 0 while nothing had been
written. It is now a refusal with a non-zero exit and no manifest. A run that wrote AT LEAST ONE key
keeps `ok:true` and exit 0 with the `REINDEX_INCOMPLETE` notice, which is what that notice was always
for.

**Partial success.** A refusal is for "nothing happened"; a notice is for "the task data was saved but
a follow-on step did not complete". The auto-commit that follows a review transition and the
`--reindex-sort-keys` post-assert now keep `ok:true` and **exit 0**, and the success payload gains an
optional **`notices` array** of `{code, message}` — `GIT_COMMIT_FAILED`, `REINDEX_INCOMPLETE`,
`SET_STATUS_DONE`, `RESEARCH_NO_IMPLEMENT`, `ALREADY_IN_PROGRESS`. The key is absent on a clean run.

**`notices`, not `warning`.** The notice field was first emitted as `warning` (a bare object) and
`warnings` (an array, when there was more than one) — a singular/plural switch a consumer had to
handle, and a name that collided with the online board's own `warning`, which is a **string** the
server sends. The local field is now always the array `notices`, so the switch is gone and the two
names cannot be confused: `warning` remains the server's passthrough string on the SaaS `--edit`
payload, and `notices` is this CLI's structured, always-an-array field. A consumer branching on
`.warning.code` on the SaaS path was reading `undefined` from a string.

**stdout is now parseable on every `--json` path.** Four pre-existing paths wrote prose to stdout
outside an envelope — the `--set-status done` warning, the Research and already-in-progress warnings,
the `--commit` auto-push lines (printed *after* the envelope, as trailing garbage), and a lost
`--verify-reason` — so `JSON.parse(stdout)` could fail on a successful run. A fifth was found by the
new sweep: `tasks --edit --json` with no task id and nothing to edit printed 750+ bytes of
"LLM Usage Instructions" and exited 0. That path is now the `E_USAGE` refusal it always was (an
impossible flag combination); the help block itself is unchanged in human mode. The only remaining
exception is `tasks --next --json` on an empty board, which prints a sentence and exits 0 by a
decision recorded in three e2e tests — documented as a bullet in the README, not as a footnote.

**A lost `--verify-reason` is lost task data.** `--set-verify cannot --verify-reason "…"` records the
reason as a system comment. When that write failed, the CLI printed a yellow line to stdout, set no
exit code and reported nothing — an explicitly requested piece of task data, silently gone. It is
now the same `E_COMMENT_SAVE` refusal as a lost `--comment` (one code, one meaning), with a suggestion
naming the remedy, and the human line is human-mode only.

**`E_USAGE` means one thing again.** Both `--commit` git failures — the one that reports
`{ok:false}` and the one that throws — used to answer `E_USAGE` while exiting with a different code
than every other `E_USAGE` site. Both now answer **`GIT_COMMIT_FAILED`**: in `error.code` it means
nothing was committed, in `notices[].code` it means the task was written and only the commit did not
happen. `E_USAGE` is again only a bad flag value or an impossible combination.

**A rejected session is no longer "the backend is down".** SaaS mode is selected *because* a token
file exists, so the client's literal `NOT_AUTHENTICATED` (returned when there is no token at all) is
the rare case; what really happens is an expired or revoked token rejected with HTTP 401/403, which
was labelled `E_BACKEND_UNAVAILABLE` — "unreachable, maybe retry". 401/403 now map to
`E_NOT_AUTHENTICATED`, `retryable: false`, with a suggestion naming `vibeflow login`.
`NETWORK_ERROR` still maps to `E_BACKEND_UNAVAILABLE` retryable. The mapping moved out of
`src/index.ts` into `src/saas/failure.ts` so it is a pure function the unit tests can reach; until
now every path to it needed a live online board, which is why it shipped untested.

**Coverage that means something.** The e2e suite spawns the CLI as a child process, which v8 coverage
does not follow, so `src/index.ts` was measured at ~10% while the e2e suite ran hundreds of
invocations through it — new branches looked untested in the report while being pinned by dozens of
assertions. `test:coverage:e2e` merges the child's counters with the unit counters: it builds a
sourcemapped, unminified CLI (the shipped bundle is minified and its maps are deleted, so it cannot be
attributed back to `src/**`), runs the e2e suite against it under `NODE_V8_COVERAGE`, remaps through
the source map, and merges **by source position** into `coverage/merged/`. `src/index.ts` lines go
16.04% → 29.83%, branches 17.70% → 39.60%, functions 23.07% → 30.59%. `test:coverage` is unchanged.
No dependency was added: the merge toolchain is already a transitive dependency of
`@vitest/coverage-v8`.

**Tests.** A stdout-purity sweep asserts, for a table of `--json` invocations, that stdout is either
empty or exactly one JSON document — the guard for the whole class, including the two sites the
deep review did not find. The non-zero-exit guard
(`tests/unit/json-refusal-guard.test.ts`) keeps its one allowlisted exception
(`reportProjectRootFailure`, whose only callers `serve`/`kanban`/`mcp` define no `--json`) and its
docstring now states its six named blind spots honestly, three of them exercised as tests.

**Breaking:** the auto-commit-failed path exits 0 instead of 1. It signalled a failure for work that
had already landed, which told a consumer to retry an edit that applied. Scripts that chained
`tasks --edit … && git push` will no longer stop there; both modes now say why in the notice. The local
notice field is `notices` (an array), not `warning`. `tasks --edit --json` with no id and nothing to
edit exits 2 (`E_USAGE`) instead of 0.

Also fixed on the way: `commitTaskPaths`/`commitTaskChanges` let git write to the CLI's own stderr,
putting a git usage dump in front of the envelope; git's stderr is now captured and folded into the
error message, so stderr parses as JSON.
