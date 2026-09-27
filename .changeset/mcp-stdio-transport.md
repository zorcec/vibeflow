---
"@vibeflow-tools/cli": minor
---

Add a stdio MCP transport: `vibeflow mcp --project <dir>`.

An MCP client (Claude Desktop, Cursor, …) can now spawn one vibeflow MCP server per project — no port, no long-running process to manage. The server speaks JSON-RPC over stdin/stdout with the same 11-tool manifest as the HTTP transport. `--project` is required (the spawn cwd belongs to the client and is never trusted), the root is resolved and validated once at startup, startup announcements go to stderr so stdout carries nothing but protocol frames, and the process exits cleanly when the client closes stdin.
