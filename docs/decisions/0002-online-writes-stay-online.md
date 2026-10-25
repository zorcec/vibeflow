# ADR-0002: online writes stay online

- Status: accepted
- Date: 2026-10-25
- Governed: `packages/cli/src/core/remote-task-store.ts`
- Governed: `packages/cli/src/saas/pull-archive.ts`
- Reviewed: 2026-10-25
- Decided by: owner (ticket 3bb51549f9ed825bfc8612ac181125)

## Background

Reads and writes against the remote board go through the remote store
adapter (`remote-task-store.ts`): one POST/PATCH per call, awaited before
success is reported. A stale local copy must never look current, so the
adapter refuses instead of falling back to local files.

## Decision

Online writes never touch the local store — no local file on success or
on refusal. Only `push`/`pull` materialise the local store from the
remote (`pull-archive.ts`). Unrouted mutations (delete, attach,
maintenance) throw `RemoteWriteNotRoutedError` loudly instead of landing
on the wrong backend.

## What follows from it

A new write path must route through the same ports or throw — never a
quiet local fallback. Each suite here runs a local dir holding a stale
sentinel the remote never names: if any path consults local files, the
sentinel shows up and the test goes red.

## Pins

Tests that fail if this rule is broken. Every path must exist:

- Pins: `packages/cli/tests/unit/remote-task-store.test.ts`
