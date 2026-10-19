---
"@vibeflow-tools/cli": patch
---

Agent chat backend (ticket 0847833f, part 2, behind
`VIBEFLOW_FEATURES=CHAT`). Per-session MCP server (`createChatMcpServer`)
with the shared manifest tools behind an approval gate (reads run free,
mutating tools pause for explicit UI approval and fail closed on
deny/timeout) plus chat-only website tools (`read_page_text` server
fetch, `read_page_dom` browser round-trip, both wrapped as
`<untrusted-webpage>`). REST surface (`/api/chat/*`, `/api/chat-mcp/*`)
with session lifecycle, approvals, DOM round-trips, and the WS-mapped
event stream. `invokeManifestTool` extracted from the MCP server with
zero behavior change so both servers share one call site.
