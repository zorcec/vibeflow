---
"@vibeflow-tools/cli": minor
---

Add a `vibeflow watch` command that watches the local task store and prints full ticket details whenever a task is newly created or moved back to `todo`.

Also includes several hardening and consistency fixes:

- tRPC task-ID inputs now enforce the 30-char hex shape, matching the REST API's `isValidTaskId` guard and blocking path-traversal IDs in file/comment endpoints.
- `tasks --edit` now resolves a unique partial task-ID prefix to the full ID, consistent with `--get` and `--commit`.
- The login push preview now handles legacy flat `.json` task files in addition to date-based subdirectories.
