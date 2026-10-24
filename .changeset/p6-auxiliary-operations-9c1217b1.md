---
"@vibeflow-tools/cli": patch
---

P6 increment 1 (ticket 9c1217b1): extract the local auxiliary commands
behind shared operations with injected ports — `getChangelog`
(`changelog [--all]`), `getOpenApiDocument` (`openapi [--yaml]`),
`manageTelemetry` (`telemetry --enable/--disable/--status`) and
`linkCommitAuthors` (`authors link [--dry-run]`) in
`core/operations/auxiliary.ts`, re-exported from the `core/operations.ts`
barrel and bound in the operation registry (operationFn set, CLI flags
added, artifact regenerated). `src/index.ts` now parses, dispatches and
renders only for these four commands. No behaviour change: the human
blocks, JSON shapes, exit codes and the EPIPE-quiet openapi write are
byte-identical (verified against the built CLI). Auth/status/sync
commands stay inline for the next P6 lane.
