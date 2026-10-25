# ADR-0003: `--commit --task` resolves through the one shared helper

- Status: accepted
- Date: 2026-10-25
- Governed: `packages/cli/src/core/tasks.ts`
- Governed: `packages/cli/src/core/git.ts`
- Reviewed: 2026-10-25
- Decided by: owner (ticket 3bb51549f9ed825bfc8612ac181125)

## Background

`--commit` once re-derived a file path AFTER resolving the id, and a
concurrent tmp-file + atomic-rename rewrite in between turned into `Task
file not found` for an id `--get` resolved in the same second. One
implementation, not two, is what fixed it.

## Decision

Every short-id resolution goes through `resolveLocalTask` in
`core/tasks.ts` — exact id wins, a unique prefix resolves, ambiguity
refuses with candidates, unknown stays missing. `--get`, `--edit`, every
task-scoped MCP tool, and `--commit` share it. A second resolution path
must never appear.

## What follows from it

Callers operate on the returned snapshot (resolved full id + file path),
never re-derive a path later; a transient `missing` is retried once, a
persistent miss fails loudly. The race suite spies on the shared helper —
bypass it and the suite goes red.

## Pins

Tests that fail if this rule is broken. Every path must exist:

- Pins: `packages/cli/tests/unit/git-commit-race.test.ts`
