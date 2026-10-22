---
"@vibeflow-tools/cli": patch
---

Online edits no longer enumerate the whole board to resolve an exact id. `tasks --edit`, `--attach --task`, and `--add --parent` now hit one detail request first (the `--get` rule) and only fall back to a single unhydrated listing when the value 404s and may be a prefix — resolver semantics unchanged (exact wins, unique prefix resolves, ambiguous is E_AMBIGUOUS naming the candidates, else TASK_NOT_FOUND). A prefix edit still costs exactly one listing, and an edit with link flags never costs two. `--delete` keeps its one listing: the online cascade warning needs the full board to name every descendant.
