---
"@vibeflow-tools/cli": patch
---

Clone mode (ticket 4efaa878): a task created while logged in (`tasks --add` in online mode) is now ALSO persisted in the local `.vibeflow` store as its normal `.json` record, so the local copy exists for grep/diff/inspection offline and the two stay identical. The clone is written from the record the server ACCEPTED (the v0 create response mapped onto local field names in `saas/clone.ts`), never re-derived from the request — including the server defaults the lossy create view hides as null (`description ""`, `selector "/"`, proven by smoke: export record == inventory hash over the same bytes). Identity is the accepted `(boardId, localTaskId)`, so `push` sees the clone as existing (converges after the first push carries the locally-minted `sortKey`, then sends nothing) and `pull` is a byte-no-op; online delete already dropped the local record and is reused unchanged; a failed online create returns before any local write, so no clone is left behind.
