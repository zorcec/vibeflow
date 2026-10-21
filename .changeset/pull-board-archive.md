---
"@vibeflow-tools/cli": minor
---

Add `vibeflow pull` (board → local additive sync, the inverse of `push`): fetches `POST /api/v0/tasks/export/archive?boardId=…` with the stored bearer token, stages the gzipped tar under `.vibeflow/.pull-tmp-*/`, verifies it (manifest version, entry counts, per-task hashes, per-file sha256) and only then merges into the local store — any verification failure writes nothing. The merge is additive and local-wins by default (`--prefer-remote` flips conflicting fields); nothing is ever deleted. Refusals map to non-retryable messages (`403 EXPORT_NOT_ALLOWED` → `E_PLAN_REQUIRED` upgrade hint, `413` → size-cap message); retries fire only for transient failures. Flags: `--board`, `--out`, `--prefer-remote`, `--dry-run`, `--json`. Ships with a `pull` MCP tool (`cliRef.command: "pull"`, `dryRun` default `false`) wired through the manifest like every other tool. Mutation not run (on-request only).
