---
"@vibeflow-tools/shared": minor
---

Add the canonical `TaskRecord` schema (Stage 1, additive only): `packages/shared/src/task-record.ts` with strict `TaskRecord` / `TaskCommentRecord` / `TaskFileRecord` / `TaskLinkRecord` / `TaskCommitRecord` schemas, the `parseTaskRecord` / `validateRecordDomain` / `toCanonicalBytes` function boundary, and the complete JSON hash domain; plus golden hash vectors loadable from both repos. No consumer changes, nothing constrained.

`type` is a free-form string (`Chore` round-trips verbatim; only the `[object Object]` artifact is rejected). The persisted comment-text bound is 1,000,000 — deliberately separate from the 10,000-character new-request authoring cap — so the three real historical texts (10,950 / 14,960 / 30,045 chars) migrate without truncation. Also fixes the `canonicalJson` M02 key-loss collision (`Object.create(null)` so a `__proto__` key survives instead of hashing like absent).
