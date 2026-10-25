---
"@vibeflow-tools/cli": patch
---

Fix `tasks --commit` failing with `Task file not found` while `--get` resolved the same ticket. The commit path re-derived a concrete file path with a second directory scan after the shared id resolution, so any concurrent store rewrite (every task operation rewrites files via tmp-file + atomic rename) in between lost a race the read path never ran. Both commit helpers now resolve through the same single lookup as reads (`resolveLocalTask`), retry once on a transient miss, and fail loudly naming the resolved id and the tasks directory tried; the commit-record link is written against the resolved snapshot and a lost link is reported instead of silently dropped.
