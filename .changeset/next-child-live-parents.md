---
"@vibeflow-tools/cli": patch
---

`tasks --next` (and the `claim_next_task` MCP tool) no longer auto-claim a todo child off a parked unit: the child fallback only takes children whose full parent chain is live work (todo/in-progress/review). Children of backlog/done parents — or dangling links — are refused and reported as stranded (with the remedy: move the parent to todo or claim by id) instead of being sliced off silently.
