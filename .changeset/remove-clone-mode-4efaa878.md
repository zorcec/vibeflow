---
"@vibeflow-tools/cli": minor
---

Online `tasks --add` no longer also writes the local `.vibeflow` record: online writes stay online, and `pull`/`push` are the only things that materialise the local store. A local copy that silently lags behind the board was worse than none.
