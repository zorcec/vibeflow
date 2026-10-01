---
"@vibeflow-tools/cli": minor
---

MCP `update_task`: `links` now MERGES, and `clearLinks` is the only destructive path.

`links` used to REPLACE the whole link set — any link you omitted was deleted, with no error. That made the natural agent move, "read a task, add one link", a way to silently destroy a parent. The CLI never had this problem: `--set-parent`, `--relates` and `--blocks` are all surgical.

The MCP surface now matches. `links` and `addLinks` both merge (re-sending a link already present is a no-op), `removeLinks` removes exactly the pairs you name, and `clearLinks: true` is the only way to remove links wholesale. `links: []` is refused with `E_USAGE` pointing at `clearLinks` rather than treated as a no-op, because under merge an empty array is almost certainly a client that still expects replace semantics — and silently doing nothing is the worst of the three possible outcomes.

The four fields are no longer mutually exclusive. Applied in a defined order: `clearLinks`, then the merge, then `removeLinks`. Sending `links` and `addLinks` together is a union, deduped.

This is a breaking wire change to a published tool. `ok` is unaffected, and every existing refusal (self-link, dangling target, cycle, second parent) keeps its code and wording.

### `vibeflow tasks --add` can now create an annotated task

`--url`, `--selector` and `--sort-key` join `--add`. Until now an annotated task — the thing this product exists to produce — could only be created over MCP; the terminal could not express it at all.

A bad `--url` is refused with the existing `E_USAGE` envelope before anything is written, matching how `--parent` refuses a dangling target. Passing no new flags leaves existing behaviour byte-identical. The dry-run preview shows every field the write would set.

Also closes three `mcpOnlyFields` gaps recorded by the G5 parity gate.

Tests: unit 1566, e2e 351 passed / 1 skipped (pre-existing), `tsc --noEmit` clean. The G5 gate now asserts `links` MERGE and fails if the description drifts back to promising replacement.