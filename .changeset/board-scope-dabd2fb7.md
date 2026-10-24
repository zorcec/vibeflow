---
"@vibeflow-tools/cli": patch
---

Every CLI request now follows one board-selection rule: an explicit `--board` flag wins, then the workspace saved by `auth login`, then auto-select only when the account has exactly one board. With 2+ boards and nothing selected, the command stops before sending anything and lists every board, telling you to re-run with `--board <boardId>` (or `vibeflow auth login` to bind a default) — a push can never land on the wrong board by guessing. `vibeflow push` also accepts `--board <boardId>` for one-off targeting.
