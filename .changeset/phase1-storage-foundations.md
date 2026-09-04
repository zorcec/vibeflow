---
"@vibeflow-tools/cli": minor
---

Phase 1 storage foundations: write lock, pure reads, status/sort consolidation.

- Add cross-process + in-process task write lock (core/lock.ts) preventing lost updates on concurrent comments/commits
- Make GET endpoints side-effect-free (listFiles/getFilePath no longer trigger migration)
- Hoist TASK_STATUSES to single source in core/types.ts (eliminates 6 inline duplicates)
- Unified priority comparator (compareTasksByPriorityThenCreated) — fixes CLI/MCP tie-break divergence
- Add migrateAllLegacyLinkedRefs sweep function for startup migration
- Export writeTaskJson for lock-safe direct writes
- MCP transport fix: pass pre-parsed req.body + correct sessionId check order
