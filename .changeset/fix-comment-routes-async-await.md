---
"@vibeflow-tools/cli": patch
---

Fix the board's comment API routes not awaiting their writes. `POST`/`PATCH`/`DELETE` on
`/api/tasks/:id/comments` called `addComment`/`updateComment`/`deleteComment` without `await`, so a
failing write could respond before it completed — the client could be told a comment was saved
while the write had actually errored. The handlers are now `async` and await the result.
