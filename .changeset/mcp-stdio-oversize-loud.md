---
"@vibeflow-tools/cli": patch
---

Answer oversized MCP stdio frames instead of dying silently.

`vibeflow mcp` used to hand stdin straight to the MCP SDK. A single inbound
JSON-RPC frame over the SDK's 10 MB read-buffer limit made its `ReadBuffer`
throw, the transport close, and the server exit with code 0 — no response
frame, nothing on stderr, and an MCP client left waiting forever.

The stdio transport now frames stdin itself: frames up to 16 MiB are served
(the old ceiling was 10 MB, so a large `attach_file` payload was fatal), and
anything larger is dropped and answered with a JSON-RPC error naming the cap
while the session keeps serving. Covered by
`tests/e2e/mcp-stdio-oversize.test.ts`, which fails on the pre-fix build with
`server exited (code=0) before responding`.
