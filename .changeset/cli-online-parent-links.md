---
"@vibeflow-tools/cli": patch
---

Remote tasks now honour parent links instead of refusing them. `tasks --add --parent` sends the parent as a `links` entry, and `tasks --edit --set-parent` / `--no-parent` read the task's current links and PATCH the merged set (old parent swapped, relates/blocks preserved) — the same answer the MCP task tools give for `create_task {parent}` / `update_task {parent}`. A dangling parent is refused with the backend's own INVALID_LINKS code on both surfaces. The remote list also applies the same root-only default (children hidden, `hiddenChildren` counted, `--children` to include them) with the same disclosure suffix as the local listing.
