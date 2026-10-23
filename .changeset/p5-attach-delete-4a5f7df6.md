---
"@vibeflow-tools/cli": patch
---

Route standalone `tasks --attach` and `tasks --delete` through the shared operation layer. Standalone attach runs `attachStandalone` (explicit local-path source, refuse-on-duplicate, `--move` consumption only after a confirmed attach); delete runs `deleteTaskOperation` (empty-id refusal, one listing-based resolver, local parent refusal, online cascade with local-clone cleanup). The online delete listing reads the board exactly like the inline branch it replaces (unhydrated `fetchSaasTasks` mapped straight off the v0 rows) instead of the strict local-task adapter, so minimal board stubs resolve the same rows. No MCP delete tool by design. CLI envelopes, exit codes, `--yes`/`--dry-run` semantics, and human preview blocks are unchanged.
