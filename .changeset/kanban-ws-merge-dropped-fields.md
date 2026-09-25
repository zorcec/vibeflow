---
"@vibeflow-tools/cli": patch
---

Fix the kanban live-update merge silently dropping task fields. The WebSocket `task-changed` handler rebuilt each task from a field allowlist that omitted nine of the 35 `Task` fields — most visibly `verified`, so the verify badge never appeared live after `--set-verify` and disappeared whenever a card was opened (the `/opened` broadcast replaced the stored task without it). `branchName`, `annotatedElementText`, `commitPushed`, `files`, `authorName`, `assigneeName`, `agent` and `model` were dropped the same way. The mapping is now a single tested `mergeTaskFromPayload` in `@vibeflow-tools/ui` with a compile-time exhaustiveness guard, so the next task field added to the type fails the build instead of shipping dropped. `verified` uses strict-boolean semantics (absence clears a stored verdict — required for `--set-verify cannot` and claim resets), and GET-only `commitPushed` is preserved from existing state rather than mapped.
