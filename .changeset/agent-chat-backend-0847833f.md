---
"@vibeflow-tools/cli": patch
---

Agent chat now runs its tools through a per-session MCP server with an explicit approval gate (behind `VIBEFLOW_FEATURES=CHAT`). Reading tools run freely; tools that change anything pause for your approval in the UI and fail closed if you deny them or the request times out. Chat-only web tools fetch page text (capped at 4000 characters) and page content via the browser, always labelled as untrusted third-party content. The server exposes session lifecycle, approvals, and a live event stream at `/api/chat/*` and `/api/chat-mcp/*`.
