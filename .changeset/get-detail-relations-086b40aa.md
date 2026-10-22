---
"@vibeflow-tools/cli": patch
---

Remote `tasks --get` now renders parent/children from the detail response: one request, no board listing. A task with children lists each child id, title and status; a task with none prints `children: none`. Responses from servers predating the detail contract print one `relations unavailable` line instead of nothing. The `--json` envelope now always carries `parentId` and `children`.
