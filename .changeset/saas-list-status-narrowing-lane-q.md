---
"@vibeflow-tools/cli": patch
---

Online listings narrow by status server-side when predicate-equal (LANE Q step 2). The remote store passes a status hint (`TaskStore.listTasks` `preFilter`, applied only for backlog/todo/in-progress/review where `?status=` matches exactly what client filtering would keep) and `fetchSaasTasks` forwards it; the operations still run the full client query, so narrowed and full-scan reads converge to identical answers. `done` stays a full scan (`?status=done` would drop storage-`cancelled` rows the client maps to done), as do type/user/tag filters, root scope, and unfiltered limited reads (server order differs from client sort). A status-filtered listing on a large board now pages only over the matching set.
