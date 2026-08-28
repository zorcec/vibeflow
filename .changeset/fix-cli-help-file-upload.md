---
"@vibeflow-tools/cli": patch
---

Fix the file-upload endpoint documented in `vibeflow --help` and used by the legacy kanban template: the correct route is `POST /api/tasks/<id>/files/<filename>` (path segment), not `?filename=` (query parameter).

Also document the `vibeflow watch` command and `vibeflow tasks --next` in the CLI help quick reference and README.
