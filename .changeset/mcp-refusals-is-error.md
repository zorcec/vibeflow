---
"@vibeflow-tools/cli": patch
---

**MCP refusals now carry the protocol `isError` flag**, so a client that trusts the MCP result — instead of parsing Vibeflow's own envelope — no longer reads a refused tool call as a success.

Every MCP tool refusal already returned `{ok:false, error:{code, message, retryable, suggestion?}}` as its text content, but the result object itself was a normal, successful tool result. A client checking `isError` (the standard way to detect a failed tool call, and the only signal many clients look at) therefore got `undefined` and reported the refusal as a successful call whose payload merely happened to say `ok:false`.

The refusals now also set `isError: true` on the result, across every MCP surface that shares the dispatch — stdio, HTTP, and the agent chat server. The JSON text is unchanged, so envelope-aware clients keep reading exactly the same shape; successful calls are unchanged and carry no `isError` key at all.
