---
"@vibeflow-tools/cli": minor
---

`limit: 0` is no longer an unbounded mode on `vibeflow tasks` / `list_tasks`: an explicit 0 (or any non-positive value) now resolves to the default page size (20) exactly like omitting the parameter, and the fallback is named loudly in the `--json` envelope and the human listing. New `tasks --all` flag pages through everything when you really want it all; cursor paging (`nextCursor`) remains the MCP path. `remaining` counts now agree with `hint`, and projected rows (`--fields` / `fields`) always carry `commentCount`/`fileCount` so a projection never silently hides discussion or attachments.
