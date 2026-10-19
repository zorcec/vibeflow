---
"@vibeflow-tools/cli": patch
---

Agent chat hardening pass (ticket 0847833f review): per-session MCP
URL carries the session id in the path (the injected `.pi/mcp.json`
entry matched no route before — agents had zero tools); pasted images
ride top-level on the pi `prompt` command; missing Stop route added
(`POST /api/chat/:id/abort`); approval gate fails closed for unannotated
tools; login-time push prints already-existed counts; `push --json`
includes the `existing` count; read_page_text caps at 4000 chars with
per-hop SSRF blocking and manual redirect following; read_dom honors
the 5 s round-trip budget with deterministic ELEMENT_NOT_FOUND/TIMEOUT
codes; image pastes over 2 MiB are skipped with a user-visible note.
