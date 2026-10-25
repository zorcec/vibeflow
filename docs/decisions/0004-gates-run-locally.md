# ADR-0004: gates run locally, releases ship from here

- Status: accepted
- Date: 2026-10-25
- Governed: `.husky/pre-commit`
- Governed: `scripts/release-cli.mjs`
- Reviewed: 2026-10-25
- Decided by: owner (ticket 3bb51549f9ed825bfc8612ac181125)

## Background

There is no remote CI: `.github/` holds only a CODEOWNERS file, a PR
template, and funding — no workflows. The pre-commit hook (identity,
gitleaks, store check, typecheck, build, unit tests) and the pre-push
hook (unit, e2e, integration, Playwright) are the gates, and GitHub
releases are created locally after `npm publish` lands.

## Decision

A gate that cannot run locally does not exist. Do not add a workflows
directory — fix the hook instead. Skipping hooks (`HUSKY=0`,
`--no-verify`) is never routine.

## What follows from it

A ticket that wants remote CI must reverse this ADR in the same commit.
This guard (`scripts/check-adrs.mjs`) is itself one of the pins: fast
and dependency-free on purpose, so the pre-commit hook can run it in
about a second.

## Pins

Hooks and scripts that carry this rule. Every path must exist:

- Pins: `.husky/pre-commit`
- Pins: `.husky/pre-push`
- Pins: `scripts/check-adrs.mjs`
