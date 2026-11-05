---
"@vibeflow-tools/cli": minor
---

Agent hooks Stage 1: operation-owned after-hook pipeline. Every mutating command (`tasks --add/--edit/--delete/--next`, `verify`, `push`, `pull`, plus the matching MCP tools) emits one typed after-event after its confirmed durable effect; a project, global, or shipped-default `.mjs` hook can append `instructions` to the result (`--json` payloads and MCP responses carry them; human mode prints them dim on stderr). Hooks are child processes with a 2s per-invocation deadline (after = fail open), direnv-style trust for project hooks, and replace-not-merge precedence. No pre-hooks or blocking yet.
