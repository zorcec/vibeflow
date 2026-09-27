---
"@vibeflow-tools/cli": patch
---

Align the MCP server's refusals and inputs with the CLI's own contracts.

**Error envelopes.** A failing MCP tool returned `{error, message, suggestion}` while `tasks --json` returns `{ok:false, error:{code, message, retryable, suggestion?}}`. A machine consumer could not parse the two surfaces the same way — the same problem the `--json` work fixed for the CLI. `formatResult` now emits the CLI envelope verbatim, with `retryable` defaulted to `false` and `suggestion` omitted when the operation set none. Success payloads are unchanged: raw JSON data, the right MCP convention.

**`add_comment`'s body is now `comment`,** not `text`. The CLI flag is `--comment` and `update_task` already uses `comment`, so one concept had two names. `vibeflow mcp` is not yet published, so there is no external consumer to break.

`patch`, not `minor`: every change here is a bug fix to an unpublished, non-deterministic surface. The `mcp` command is not on npm yet, the manifest is the only consumer of the renamed field, and the envelope change is a breaking *reshape* of an internal wire format rather than a new capability. `minor` is reserved in this repo for the breaking `--json` reshape, which shipped as a documented payload change in this same release; these are the follow-up corrections to it.
