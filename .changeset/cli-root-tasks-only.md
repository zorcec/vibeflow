---
"@vibeflow-tools/cli": minor
---

List and claim root tasks only, and return a root's children with it.

`vibeflow tasks` now lists ROOT tasks only — a task with a parent is not shown as a peer, because it belongs to its parent, matching how the board renders it. A footer reports how many child tasks the query matched and names the flag that reveals them, so the count is never hidden silently. Pass `--children` to include them.

`vibeflow tasks --next` now considers only root tasks whose own status is `todo`. It never claims a child: the root is the unit of work, and the result carries that root's children with their ids, titles and statuses so an agent can see what remains without a second call. `--get <id>` is unaffected and still resolves any task, child or root.
