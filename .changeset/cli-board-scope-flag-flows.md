---
"@vibeflow-tools/cli": patch
---

Scope every v0 write with the resolved board id, not the saved workspace peek.

`push --board <id>` / `pull --board <id>` without a prior `auth login`
(throwaway HOME, CI) sent the import POST, task creates, file uploads, link
replay and archive fetch with no `X-Vibeflow-Scope`, because those sites
built headers from the saved-workspace file — which does not exist in a
login-less flow. On a multi-board account the server answers 422
`SCOPE_REQUIRED` to every one of them (and creating the target board is
itself what makes the account multi-board, so scripted push/pull against a
fresh board failed 100% of the time: 0 created, every file refused).

The resolved board id was already in hand at each site
(`postImportChunk`, `createTasksOneByOne`, `uploadTaskFiles` /
`uploadPushedFiles`, `applyPushLinks`, the delta archive run, the pull
archive fetch) — it now scopes the header via `scopeHeaderFor(boardId)`.
The saved-workspace peek remains only as the fallback for callers that pass
no board. Per-file failure lines (`- <name>: HTTP 422 SCOPE_REQUIRED`) are
unchanged and already printed by both push paths.
