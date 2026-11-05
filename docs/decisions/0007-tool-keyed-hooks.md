# ADR-0007: agent hooks are keyed by TOOL, and shipped defaults live read-only inside the package

- Status: accepted
- Date: 2026-11-06
- Supersedes: ADR-0006
- Governed: `packages/cli/src/core/hooks/`
- Reviewed: 2026-11-05
- Decided by: owner (ticket d552207737ba3ee1a22ad6476789fc, Hooks v2)

## Background

ADR-0006 keyed hooks by internal event (`after-task.update.mjs`) and materialised shipped defaults out of the bundle into `~/.vibeflow/hooks/defaults/` on version change. The owner directed two changes: every hook file is named after its TOOL/COMMAND (`tasks.after.mjs`, `kanban.after.mjs`, `create_task.before.mjs`, …) covering every CLI command and all 13 MCP tools, and shipped defaults live INSIDE the npm package (`dist/hooks/defaults/`, read in place — npm upgrade upgrades them). The `~/.vibeflow/hooks/defaults/` materialisation copy was rejected in review. This ADR supersedes ADR-0006; ADR-0006 is kept as history and never deleted.

## Decision

1. **Key = tool.** One hook file per `<tool>.<phase>`; the tool set is the canonical commander command paths (15) plus the 13 MCP tool names, with hidden aliases (`login`→`auth.login`) resolving to their canonical key and containers (`authors`) explicitly unrunnable. Adding a command/tool without adding a registry row fails the guard test.
2. **Two granules, one execution rule.** The file granule is the tool; the payload granule is the 8 activities; one execution per (tool, activity) unit of work and exactly one null-activity execution for a successful invocation that emitted nothing.
3. **The envelope is v2**: `tool`, `surface`, `phase: before|after`, `activity: …|null`, `payload: …|null`, and the owner generic contract `task`/`activity`/`activityObject`/`instructions`. The `event` field is removed (it always equalled `activity`); `schemaVersion` is 2.
4. **The after-envelope carries the confirmed record.** `task.create/update/claim/comment` carry the post-write snapshot (`task.delete` carries the pre-delete row), `activityObject` carries the secondary record (changed keys, written comment, claim filters), and run intents (`push`/`pull`/`verify`) carry `task: null` by design. The same snapshot rule governs `before` envelopes (best-known intent, never a generated id).
5. **Precedence + replace-not-merge unchanged** (project > global > shipped, first hit wins, conflicts refuse).
6. **Defaults ship in the package, read in place** at `dist/hooks/defaults/`, trusted without prompting, upgraded by `npm/pnpm update`, never materialised into `$HOME`, and shipped iff the tool covers an activity (no before defaults).
7. **Trust is code execution, not a sandbox** — unchanged, plus: the shipped root is derived from the running bundle and containment is compared against that same realpath, which is what makes npm/pnpm/npx layouts safe without any path allowlist.
8. **Failure policies, bounds, env allowlist, stdout purity, bypass audit unchanged**; the vocabulary is `before`/`after` in names, phases and codes. `console.log/info/warn/debug` is rerouted to child stderr (stdio preloads `hook-console-guard.mjs` via `node --import`, module/TS get the loader-top patch) — the stdout contract is unchanged, now enforced: chatter can never become an instruction, raw `process.stdout.write` pollution still fails the same way. The child env allowlist gains exactly one entry: `VIBEFLOW_HOOK_RUNTIME` (absolute path to `dist/hooks/hook-runtime.mjs`, injected by the runner — item 3 of the same ticket; still never a token).
9. **Before is for writes:** `.before` is supported only for gateable tools; a `.before` file for a read/container tool is refused loudly, never silently ignored.
10. Test hermeticity: `VIBEFLOW_HOOKS=0` (unchanged). Adding a 9th activity, replacing the registry with per-call logic, or re-introducing a `$HOME` defaults copy must revisit this ADR in the same commit.

## What follows from it

Renaming a hook file away from `<tool>.<phase>`, gating a read, executing hooks in-process, merging overrides, or copying defaults back into `$HOME` must revisit this ADR in the same commit.

## Pins

- Pins: `packages/cli/tests/unit/hooks/tool-contract.test.ts`
- Pins: `packages/cli/tests/unit/hooks/discover.test.ts`
- Pins: `packages/cli/tests/unit/hooks/envelope.test.ts`
- Pins: `packages/cli/tests/unit/hooks/runner.test.ts`
- Pins: `packages/cli/tests/unit/hooks/packaged-defaults.test.ts`
- Pins: `packages/cli/tests/unit/hooks/emit.test.ts`
- Pins: `packages/cli/tests/unit/hooks/before-gate.test.ts`
- Pins: `packages/cli/tests/unit/hooks/hook-runtime.test.ts`
- Pins: `packages/cli/tests/integration/hooks-package.test.ts`
- Pins: `packages/cli/tests/e2e/hooks-tool-keys.test.ts`
