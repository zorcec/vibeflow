---
"@vibeflow-tools/cli": major
"@vibeflow-tools/api-core": major
---

BREAKING: removed the `export_prompt` MCP tool and its `exportPrompt` operation. Its single-task read is
covered by `get_task` and its human render by `vibeflow tasks --get` (both via `renderTaskForAgent`,
which stays); callers needing the old multi-task dump can loop `get_task` over the ids from `list_tasks`.

Also improves the remaining 11 tool descriptions toward the Glama TDQS rubric (ticket 53b622fc): every
description now names sibling routing (`use X …; use Y instead …`), discloses behavior the annotations
cannot express (claim null contract, attach overwrite-in-place, verify E_NO_BASELINE/VERIFY_TIMEOUT,
dryRun preview on every mutating tool), and the input schemas now describe the previously undocumented
fields (list filters, `fields` projections, claim filters, `author`, `url`/`timeoutMs`/`dryRun`,
create/update defaults). The `tasks --json` CLI flag, previously owned only by the removed tool's
`cliRef`, is now classified as deliberately unexposed (the MCP wire is already JSON).
