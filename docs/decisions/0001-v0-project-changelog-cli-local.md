# ADR-0001: v0 project/changelog are CLI-local

- Status: accepted
- Date: 2026-10-25
- Governed: `packages/cli/src/server/v0.ts`
- Reviewed: 2026-10-25
- Decided by: owner (ticket 3bb51549f9ed825bfc8612ac181125)

## Background

The CLI local server mounts `GET /api/v0/project` and
`GET /api/v0/changelog` as thin aliases over the legacy local handlers.
Nothing on any remote surface calls them — the conformance manifest marks
`get-project` as `surfaces: ["local"]`, and the web side has no such routes
by decision (private ADR-0015).

## Decision

These two v0 reads are CLI-local-only. Never add them to a hosted surface
to "complete" the spec, and never delete them as "unused" — the kanban
bundle, the overlay, and What's New fetch them against the local origin.

## What follows from it

A ticket that wants these paths anywhere else must reverse this ADR in the
same commit AND drop the `local-only` conformance skip AND update the
scope-gate pins — a silent half-reversal fails the suite on its own.

## Pins

Tests that fail if this rule is broken. Every path must exist:

- Pins: `packages/cli/tests/unit/api-v0/scope-gate.test.ts`
- Pins: `packages/cli/tests/unit/api-v0/conformance-surfaces.test.ts`
- Pins: `packages/cli/tests/unit/api-v0/v0-parity.test.ts`
