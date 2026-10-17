---
"@vibeflow-tools/cli": minor
---

Kanban dev mode (7e85c338): explicit `--dev` flag (also `VIBEFLOW_DEV=1`) serves the on-disk `kanban-browser.js` as a separate no-store asset instead of the production inlined megastring, and the server broadcasts `{ type: "kanban-reload" }` on the existing task-sync websocket whenever `tsup --watch` rewrites the bundle — the dev board shell full-page reloads on that frame, so editing the kanban client refreshes the browser with no server restart. Production (default) is byte-identical: single-file inlined bundle. Full-page live reload only; React Refresh state preservation is intentionally not shipped (a full reload cannot leave stale module state behind). Stays on tsup 8.x: this ticket changes serving architecture, which is bundler-agnostic, and `tsup --watch` already rebuilds correctly.
