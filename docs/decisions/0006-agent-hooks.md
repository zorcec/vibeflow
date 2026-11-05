# ADR-0006: agent hooks are operation-owned child processes with replace-not-merge defaults

- Status: accepted
- Date: 2026-11-05
- Governed: `packages/cli/src/core/hooks/`
- Reviewed: 2026-11-05
- Decided by: owner (ticket 21f80286b972bceabe4d9660c526f3, Sol review approve-with-changes)

## Background

Users need team policy without editing the binary: a `pre` gate that can block and an `after` whisper that appends instructions to an agent's prompt. The plan, the Sol review, and the Stage 1 scope live on the parent ticket; this ADR pins the contracts that review found load-bearing.

## Decision

1. **Operation-owned events, after-only in Stage 1.** The 8 events (`task.create/update/claim/delete/comment`, `push`, `pull`, `verify`) are emitted by the owning operation (or owning command for push/pull) AFTER the confirmed durable effect — never by a TaskStore decorator (push/pull/verify are not store methods; online delete never calls a store delete). Dry-run and no-op emit nothing; partial success emits only the confirmed effect. Generated system comments never pass through an emitting call site, so no hook cycle is possible by construction.
2. **Child process only, two deterministic modes.** `after-<event>.mjs` is the stdio mode (JSON envelope on stdin); `after-<event>.hook.mjs` is the module mode (the packaged `hook-loader.mjs` owns stdin/stdout and awaits the default export with the envelope as its sole argument). Mode is chosen by filename extension only — never by source inspection or auto-detection — and both files at one level is `HOOK_CONFIG_CONFLICT` (no hook runs, no fallback to a lower level). Both modes share the 2 s per-invocation deadline (whole process tree killed), byte limits, env allowlist, trust, the `{instructions}`/`{}` parser, and the fail-open one-stderr-line policy. Never in-process JS. Public authoring is type-only (`@vibeflow-tools/cli/hooks`, after-only union — no pre payload is promised).
3. **Trust is code-execution permission, not a sandbox.** Only project hooks prompt (direnv-style sha256 in `trust.json`); global and shipped defaults are the user's own bits. The entry-file hash is not transitive integrity, and non-TTY refuses by design.
4. **Replace, never merge.** Project beats global beats shipped default; the first hit wins and an override replaces. Only `*.mjs` executes; `.js`/`.cjs` are refused loudly; symlinks never inherit trust across roots.
5. **Defaults are unconditional text only.** Everything settings- or type-dependent stays rendered by the CLI; byte-identical extraction applies to the extracted sections only.
6. **Instruction transport is one document or the existing failure channel.** Success carries `instructions: string[]` (absent when no hook ran) through `OperationResult`, the CLI `--json` envelopes, and the MCP `successPayload`; failures keep their existing channel.
7. **Test hermeticity is explicit.** `VIBEFLOW_HOOKS=0` disables emission (the test setup uses it; hook tests opt back in per case). No silent fallback anywhere else.

## What follows from it

Adding a 9th event, moving emission into the store layer, executing hooks in-process, or merging overrides must revisit this ADR in the same commit. Pre-hooks (Stage 2) keep phase-discriminated payloads (pre=intent, after=result) — the split is already in the envelope types.

## Pins

- Pins: `packages/cli/tests/unit/hooks/envelope.test.ts`
- Pins: `packages/cli/tests/unit/hooks/runner.test.ts`
- Pins: `packages/cli/tests/unit/hooks/discover.test.ts`
- Pins: `packages/cli/tests/unit/hooks/trust.test.ts`
- Pins: `packages/cli/tests/unit/hooks/emit.test.ts`
- Pins: `packages/cli/tests/unit/hooks/defaults.test.ts`
- Pins: `packages/cli/tests/unit/hooks/hook-loader.test.ts`
- Pins: `packages/cli/tests/integration/hooks-package.test.ts`
