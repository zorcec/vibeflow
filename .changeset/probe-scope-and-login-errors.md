---
"@vibeflow-tools/cli": patch
---

Fix push on accounts with more than one board.

`auth login` could finish without selecting a board (the boards fetch failed, or
the picker could not prompt) and said nothing, then `push` probed the import
capability with no board scope and aborted with `HTTP 422`. Sending a board id
is now done through the documented `X-Vibeflow-Scope` header, so
`push --workspace <boardId>` works on a multi-board account, and a 422 reports
"this account has more than one board and none is selected" with the two ways
out instead of reading like a network failure. Login reports why board
selection failed instead of swallowing it.
