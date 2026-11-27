# ADR-0005: auth is project-scoped, never machine-global

- Status: accepted
- Date: 2026-10-25
- Governed: `packages/cli/src/auth/`
- Reviewed: 2026-11-27 (re-read after the push surfaces in `auth/login.ts` began stamping `X-Vibeflow-Agent`, ticket uge57p8j — that header names the caller's agent for echo suppression and never feeds `resolveProjectAuth`, so the decision is unchanged)
- Reviewed: 2026-11-23 (re-reviewed with the 73cb9048 fix (refusal is a property of the command) and its online-read e2e — decision unchanged)
- Reviewed: 2026-11-09
- Decided by: owner (ticket a93bfdc8c858ed0aa5cc60aa56e328)

## Background

One `~/.vibeflow/token` flipped every project on the machine online. Resolution must come from the project's own pointer, with secrets user-scoped per host.

## Decision

`resolveProjectAuth(projectDir)` is the only resolution: repo pointer plus user-scoped credentials keyed by apiUrl. No pointer means local; a pointer without a credential refuses, never silent local.

## What follows from it

Reversing this needs a global read plus deleting the pins below, in the same commit. The legacy token stays retired: noticed, never read.

"Refuses" is a property of the COMMAND too, not only of the resolver: a CLI command resolves its access once per invocation (`auth/mode.ts:resolveCommandAccess`) and stops with `NOT_CONNECTED` before any branch runs. `getMode()` alone folds the unlinked state into "local", and a command that trusted it printed `✓ Task created` for a write that landed in the local store of a project that declares itself online (ticket 73cb9048).

## Pins

- Pins: `packages/cli/tests/unit/auth/project-auth.test.ts`
- Pins: `packages/cli/tests/unit/auth/mode.test.ts`
- Pins: `packages/cli/tests/unit/mcp/session-retarget.test.ts`
- Pins: `packages/cli/tests/e2e/tasks-online-write-effects.test.ts`
- Pins: `scripts/check-no-credentials.mjs`
