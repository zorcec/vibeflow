---
"@vibeflow-tools/cli": minor
---

Add two MCP tools — `start_kanban` and `get_integration_guide` — so an MCP client can reach the kanban board and the overlay integration guide, which until now existed only on the CLI and HTTP surfaces.

`start_kanban` starts the board server and returns the instruction block the CLI prints: the kanban URL, the localhost URL when bound to `0.0.0.0`, the agent prompt, and the integration guide. It is a singleton — a second call returns the instance the first started rather than fighting it for the port (which is what backs its `idempotentHint`), and concurrent calls coalesce on the in-flight bind. A port already held by another process is a clean `KANBAN_PORT_IN_USE` refusal, not a raw stack. It defaults to port 3700, matching `vibeflow serve`, and accepts `port`, `host`, and `dryRun`.

`get_integration_guide` returns the overlay/bookmarklet instructions and works whether or not the server is running: live URLs from the running instance, or the default port plus an explicit "not running, call `start_kanban` first" signal. Read-only.

Three changes underneath:

**One guide builder.** The startup guide was spelled out inline in two `console.log` blocks in `server.ts`, a third time as HTML on `/inject`, and a fourth time in the `vibeflow kanban` command. It is now built once in `server/startup-guide.ts` and derived everywhere. Human-facing output is byte-identical — verified by capturing all 8 startup modes (local, LAN-dual, no-Ctrl-C, online, online-dual, and both HTML-target modes) plus 3 `/inject` page renderings before and after the refactor and diffing them.

**stdout suppression for programmatic callers.** Under the MCP stdio transport stdout *is* the JSON-RPC channel, so `serve()`'s guide would have corrupted the protocol stream. `ServeOptions.quiet` suppresses it and the guide is read from `ServeInstance.guide` instead — the same hazard and the same precedent as `announceProjectRoot` in `src/index.ts`. The human CLI path is untouched.

**A pre-existing `serve()` bug, fixed.** A port collision did not reject the promise `serve()` returns: `WebSocketServer({ server })` re-emits the HTTP server's `error` event on itself, and an EventEmitter `error` with no listener throws — so the caller hung forever instead of learning the port was taken. `createBaseServer()` now installs a `wss.on("error")` handler, which is what makes the `KANBAN_PORT_INUSE` refusal possible at all.
