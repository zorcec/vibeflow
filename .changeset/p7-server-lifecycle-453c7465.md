---
"@vibeflow-tools/cli": patch
---

Server lifecycle behind shared operations (ticket 453c7465, P7
server-lifecycle increment). New `startServer` and `startMcpTransport`
operations in `core/operations/server.ts` own the startup decisions for
`vibeflow serve [target]` (prototype vs API-only mode, port/host/open/dev
assembly, bind-failure mapping to SERVER_PORT_IN_USE/SERVER_START_FAILED)
and `vibeflow mcp --project <dir>` (backend mode resolution, stdio
transport start, MCP_TRANSPORT_START_FAILED); both run through required
injected ports so unit tests drive fakes instead of real listeners. The
`serve`/`mcp` CLI handlers keep flag parsing, root resolution/announcement
and exit codes and now route through these operations. No behaviour change
on success paths; startup failures now print a clean `✗` refusal (exit 1)
instead of an unhandled stack.
