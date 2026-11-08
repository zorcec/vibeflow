# @vibeflow-tools/api-core

## 0.2.2

### Patch Changes

- 763a3db: Needs-attention flag on tasks. `tasks --edit <id> --set-attention --comment "<reason>"` flags a task (amber "Needs attention" badge on the card, child rows and detail header); `--set-attention` without `--comment` is refused with `E_USAGE` since the comment carries the reason. `--clear-attention` clears the flag with no comment. MCP `update_task` gains matching `setAttention` / `clearAttention` inputs with the same comment requirement and refusal codes. The flag change reads in the activity feed as an `attention` change row (clear to flagged) next to the reason comment. The field flows end to end: task type, record schema, online PATCH body, remote-task-store round-trip, kanban merge, and field diff.

## 0.2.1

### Patch Changes

- 8cd2ea1: Sync hosted MCP tool declarations with the CLI manifest (TDQS follow-up): claim_next_task, get_file and pull descriptions plus create_task/update_task (--fields), attach_file (--attach) and pull (--prefer-local) cliRef flags now match `packages/cli/src/mcp/manifest.ts`, so remote clients see the same usage tips as local ones. No behavior change.

## 0.2.0

### Minor Changes

- ac668a9: BREAKING: removed the `export_prompt` MCP tool. Its single-task read is covered by `get_task` and its human render by `vibeflow tasks --get`; callers needing the old multi-task dump can loop `get_task` over the ids from `list_tasks`. The remaining 11 tool descriptions now name sibling routing, disclose behavior annotations cannot express (claim null contract, attach overwrite-in-place, verify codes, dryRun previews), and the input schemas document previously undocumented fields.
- 65d08e5: Two new v0 batch-import operations: `POST /api/v0/tasks/batch` creates up to 100 tasks per chunk with per-item results in request order (one bad item never sinks the batch); `GET /api/v0/tasks/batch` is the preflight probe reporting remaining capacity before the first POST. Additive only — no existing operation changed.
