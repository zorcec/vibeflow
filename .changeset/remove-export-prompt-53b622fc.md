---
"@vibeflow-tools/cli": major
"@vibeflow-tools/api-core": major
---

BREAKING: removed the `export_prompt` MCP tool. Its single-task read is covered by `get_task` and its human render by `vibeflow tasks --get`; callers needing the old multi-task dump can loop `get_task` over the ids from `list_tasks`. The remaining 11 tool descriptions now name sibling routing, disclose behavior annotations cannot express (claim null contract, attach overwrite-in-place, verify codes, dryRun previews), and the input schemas document previously undocumented fields.
