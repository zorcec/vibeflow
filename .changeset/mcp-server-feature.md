---
"@vibeflow-tools/cli": minor
---

Add MCP (Model Context Protocol) server so AI agents can manage vibeflow tasks over stdio or HTTP.

- 10 tools: create_task, list_tasks, get_task, update_task, add_comment, attach_file, claim_next_task, verify_task, push_tasks, get_settings
- Operations layer (core/operations.ts) shared between MCP and future surfaces
- HTTP transport with session lifecycle, rate limiting, and token auth (timing-safe compare)
- verify_task runs the real verification engine with semaphore + timeout
