---
"@vibeflow-tools/cli": minor
---

CLI: attach a file (e.g. an implementation plan) to a ticket (ticket 25f92bc8).
New `vibeflow tasks --attach <path> --task <id>` (with `--move` to delete the
source after a successful attach and `--dry-run`/`--json` support): uploads
one file to a task's file list without changing any field, on any task type,
in both modes — local via the record's `saveFile` path, online via
`POST /api/v0/tasks/:id/files` (multipart `file` field, same contract the
web kanban upload speaks). The target is the explicit `--task` value (full
id or unique prefix, resolved by the existing `resolveSaasTaskId` online /
first-match rule locally); the same (task, name) pair is never uploaded
twice (E_FILE_EXISTS refusal naming the file). Directories, empty files,
executable types, and files over `MAX_FILE_SIZE` are refused with the limit
printed. `--json` answers `{ok,taskId,fileId,name,size}`.
