---
"@vibeflow-tools/cli": patch
---

MCP list/get now apply the same record schema and quarantine as CLI-online reads. The remote adapter validates every board row through the shared record reader, so a row the CLI would quarantine (for example a description over 20,000 characters) is excluded from MCP and CLI-online listings with the same `TASK_RECORD_QUARANTINED` notice, and an invalid detail refuses instead of serving a stale copy. A top-K page containing invalid rows falls back to the full scan so valid rows below the page are not lost.
