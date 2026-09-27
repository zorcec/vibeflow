---
"@vibeflow-tools/cli": patch
---

Align the MCP server's refusals and inputs with the CLI's own contracts.

**Error envelopes.** A failing MCP tool returned `{error, message, suggestion}` while `tasks --json` returns `{ok:false, error:{code, message, retryable, suggestion?}}`. A machine consumer could not parse the two surfaces the same way — the same problem the `--json` work fixed for the CLI. `formatResult` now emits the CLI envelope verbatim, with `retryable` defaulted to `false` and `suggestion` omitted when the operation set none. Success payloads are unchanged: raw JSON data, the right MCP convention.

**`add_comment`'s body is now `comment`,** not `text`. The CLI flag is `--comment` and `update_task` already uses `comment`, so one concept had two names. `vibeflow mcp` is not yet published, so there is no external consumer to break.

**`verify_task` accepts `dryRun`.** Every other mutating tool exposed one, and the manifest's own classification of `tasks --dry-run` says so — but `verify_task` mutated the task (system comment, verdict) while advertising no preview, so a client could not ask what it would do. `dryRun:true` now returns the task plus a `steps` preview and short-circuits before the engine, which shells out to a browser. Still unpublished, so no consumer to break.

**One id-resolution rule, three surfaces.** The CLI, the HTTP `PATCH`/create route and the MCP tools each inlined "full id, or a prefix of one" at their own call sites, which is how they drifted. It now lives in one helper in `core/tasks.ts` and every surface calls it; behaviour is unchanged, including the `tasks --get` SaaS path and the `listTasksWithPaths` caller that needs its file path.

`patch`, not `minor`: every change here is a bug fix to an unpublished, non-deterministic surface. The `mcp` command is not on npm yet, the manifest is the only consumer of the renamed field, and the envelope change is a breaking *reshape* of an internal wire format rather than a new capability. `minor` is reserved in this repo for the breaking `--json` reshape, which shipped as a documented payload change in this same release; these are the follow-up corrections to it.
