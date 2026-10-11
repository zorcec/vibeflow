---
"@vibeflow-tools/cli": patch
---

`tasks --next` no longer claims work blocked by unfinished gates

`--next` ignored `blocks` links entirely, so once children became claimable it could hand out a todo child blocked by an unfinished gate (e.g. a decommission step blocked by an unpassed parity gate — deleting the evidence the gate needs). Only `done` satisfies a `blocks` link now: `review` counts as unfinished, and every filter-matching todo blocked by non-`done` work is skipped at claim time. The skip is always named — the human run prints a `skipped N blocked task(s)` section with each task and its blockers (`<id> <title> — blocked by <id> <title> [status]`), and `--json` carries the same list as `blocked`. When every remaining candidate is blocked, nothing is claimed and the report reads `All remaining todo tasks are blocked (N) — nothing claimed`, with `task: null, allBlocked: true` in `--json`, so "all work is blocked" is distinguishable from "no work".
