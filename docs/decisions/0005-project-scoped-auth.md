# ADR-0005: auth is project-scoped, never machine-global

- Status: accepted
- Date: 2026-10-25
- Governed: `packages/cli/src/auth/`
- Reviewed: 2026-10-25
- Decided by: owner (ticket a93bfdc8c858ed0aa5cc60aa56e328)

## Background

One `~/.vibeflow/token` flipped every project on the machine online. Resolution must come from the project's own pointer, with secrets user-scoped per host.

## Decision

`resolveProjectAuth(projectDir)` is the only resolution: repo pointer plus user-scoped credentials keyed by apiUrl. No pointer means local; a pointer without a credential refuses, never silent local.

## What follows from it

Reversing this needs a global read plus deleting the pins below, in the same commit. The legacy token stays retired: noticed, never read.

## Pins

- Pins: `packages/cli/tests/unit/auth/project-auth.test.ts`
- Pins: `packages/cli/tests/unit/mcp/session-retarget.test.ts`
- Pins: `scripts/check-no-credentials.mjs`
