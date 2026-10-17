---
"@vibeflow-tools/cli": patch
---

MCP `list_tasks` and CLI `tasks --limit` now share one default page size (`DEFAULT_LIST_LIMIT = 20`, previously an undocumented 5 on each surface), and every local listing response carries position metadata — `offset`, `remaining`, `nextCursor` (null when exhausted) and `order` — so a caller can tell where it is and how much is left.
