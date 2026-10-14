---
"@vibeflow-tools/cli": patch
---

`vibeflow_list_tasks` and `vibeflow tasks` now share one listing model, so they answer the same question the same way. A filtered query (status/type/user/tag) is an explicit search returning every match, children included, on both surfaces; the MCP response carries labelled counts (`totalMatching`, `totalRoots`, `hiddenChildren`, `returned`, `limit`, `truncated`, plus a `hint` when the limit cuts rows) instead of a bare root-count `total`, and the CLI `--json` listing reports the same fields.
