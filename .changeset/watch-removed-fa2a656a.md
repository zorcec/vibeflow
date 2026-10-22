---
"@vibeflow-tools/cli": minor
---

Remove the `watch` feature entirely (ticket fa2a656a). The `vibeflow watch`
command is gone with its polling loop (`commands/watch.ts`), the local
snapshot/diff/sink helpers (`core/watch-events.ts`, `core/watch-state.ts`,
`core/watch-sinks.ts`) that nothing else imported, and its unit suites.
There is no `watch` MCP tool, so the manifest loses only its
`intentionallyNotExposed` entry and the parity/drift tests assert the
command is gone. `pull` (and the kanban board) remain the sync mechanisms;
README and CLI help no longer mention `watch`.
