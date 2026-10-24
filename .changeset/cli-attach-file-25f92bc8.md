---
"@vibeflow-tools/cli": minor
---

`vibeflow tasks --attach <path> --task <id>` attaches a file (e.g. an implementation plan) to a ticket without changing any field, on any task type, locally and online. It supports `--move` (delete the source after a successful attach), `--dry-run`, and `--json` (answering `{ ok, taskId, fileId, name, size }`). The target is the explicit `--task` value (full id or unique prefix); the same file is never uploaded twice (`E_FILE_EXISTS` names the file). Directories, empty files, executable types, and files over the size limit are refused with the limit printed.
