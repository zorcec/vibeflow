---
"@vibeflow-tools/cli": minor
---

New kanban dev mode: `--dev` (or `VIBEFLOW_DEV=1`) serves the board script as a separate asset and the dev board full-page reloads whenever the bundle rebuilds, so editing the kanban client refreshes the browser with no server restart. Production is unchanged (single-file inlined bundle). Full-page reload only — no state preservation.
