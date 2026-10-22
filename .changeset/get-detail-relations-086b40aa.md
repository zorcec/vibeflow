---
"@vibeflow-tools/cli": patch
---

Remote `tasks --get` now renders parent/children from the detail response: one request, no board listing. A task with children lists each child id, title and status; a task with none prints `children: none`. A response carrying no relation fields prints one cause-neutral `relations unavailable in this response` line instead of nothing. The `--json` envelope carries `parentId`/`children` only when the response actually carried them — each key stays absent for legacy shapes instead of being synthesised to `null`/`[]`.
