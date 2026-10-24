# @vibeflow-tools/api-core

## 0.2.0

### Minor Changes

- ac668a9: BREAKING: removed the `export_prompt` MCP tool. Its single-task read is covered by `get_task` and its human render by `vibeflow tasks --get`; callers needing the old multi-task dump can loop `get_task` over the ids from `list_tasks`. The remaining 11 tool descriptions now name sibling routing, disclose behavior annotations cannot express (claim null contract, attach overwrite-in-place, verify codes, dryRun previews), and the input schemas document previously undocumented fields.
- 65d08e5: Two new v0 batch-import operations: `POST /api/v0/tasks/batch` creates up to 100 tasks per chunk with per-item results in request order (one bad item never sinks the batch); `GET /api/v0/tasks/batch` is the preflight probe reporting remaining capacity before the first POST. Additive only — no existing operation changed.
