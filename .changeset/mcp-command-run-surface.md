---
"@vibeflow-tools/cli": patch
---

The CLI now reports MCP tool usage to PostHog: every MCP tool call emits the same `command_run` event the CLI commands already emit, tagged `surface: "mcp"` (existing CLI events now carry `surface: "cli"`), plus the tool name, its CLI command equivalent, and the outcome (`ok`). MCP and CLI usage are directly comparable with a single PostHog filter. Same opt-out (`VIBEFLOW_TELEMETRY=0` / `vibeflow telemetry --disable`), same no-PII guarantee — no paths, ids, or content leave the machine.
