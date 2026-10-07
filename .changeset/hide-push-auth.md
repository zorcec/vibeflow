---
"@vibeflow-tools/cli": patch
---

Hide the SaaS-sync surface (`push` and `auth`) while keeping it functional

`vibeflow push` and `vibeflow auth` (like `login`, `logout` and `status`
before them) are now hidden from `--help` and from all user-facing docs, but
both commands still work exactly as before. The `push_tasks` MCP tool is
removed — the manifest holds 12 tools — and `push` is classified in
`intentionallyNotExposed.commands`, since the sync stays available via the
hidden CLI command. No behaviour changes: the push operation, its flags and
its tests of the underlying sync are untouched.
