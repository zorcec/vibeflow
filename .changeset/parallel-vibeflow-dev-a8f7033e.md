---
"@vibeflow-tools/cli": patch
---

One-command dev loop (a8f7033e): `pnpm vibeflow` (root) runs the watching rebuild and the dev board in parallel via a bespoke `scripts/dev-parallel.mjs` runner — no new dependency. Output is prefixed per half, one Ctrl+C stops both with no orphans, and extra args forward to the board (e.g. `pnpm vibeflow -- -p 45210`).
