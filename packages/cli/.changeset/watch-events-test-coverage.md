---
"@vibeflow-tools/cli": patch
---

Add unit test coverage for watch-engine diffTaskSnapshots: tests all 7 event types (new, moved-to-todo, status, comment, file, priority, description) plus edge cases (no-op, simultaneous changes, ordering). Mutation score for watch-events.ts: 93.94%.
