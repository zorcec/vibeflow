---
"@vibeflow-tools/cli": patch
---

Share one authoritative read resolution between the CLI and local MCP. Read operations (`list_tasks`, `get_task`) now resolve their store through a single mode-to-backend decision: remote mode reads the shared board via a read-only adapter, local mode reads the local files. A remote failure refuses instead of falling back to a stale local copy, single-task reads stay detail-first, and list pagination refuses on a repeated cursor or a page without a task list.
