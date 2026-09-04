---
"@vibeflow-tools/cli": patch
---

fix(cli): comment-edit broadcast + attach validation + error surfaces (audit Phase 4)

- Add broadcast to comment-edit REST and tRPC routes to fix stale live UI on
  comment edits.
- Add a `broadcastTaskUpdated` normalization helper for all `tasks-updated`
  broadcasts, preventing drift across routes.
- Introduce `SaasResult<T>` discriminated union type for SaaS client functions
  to replace silent null returns.
- Update all SaaS callers in CLI to handle typed error codes and messages.
