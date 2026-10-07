---
"@vibeflow-tools/cli": patch
---

test(cli): pin the review-gate whitespace guards, the board task summary and the multi-tag filter

No behaviour change — three coverage gaps surfaced by a test-quality review:

- `tests/unit/review-gate.test.ts` gains whitespace-only fixtures for the three
  `.trim()` gates — `--commit-message "   "`, `--branch "   "` and
  `--set-verify cannot --verify-reason "   "` — each with a positive control
  proving the gate is value-sensitive. No fixture before this passed a
  whitespace-only value, so dropping a `.trim()` was invisible to the suite and
  would have let `--commit-message "   "` reach git.
- New `tests/unit/client/kanban-summary-filter.test.tsx` asserts the rendered
  board-header summary (`2 open · 1 in-progress · 1 in review`, and
  `1 of 3 tasks` for a case-insensitive search — uppercase input included), and
  that a multi-tag filter is an AND: `filterState.tags.every(...)` → `some` is
  a silent AND→OR inversion of the filter that previously survived.
