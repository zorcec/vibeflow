---
"@vibeflow-tools/cli": patch
---

Fix `push` failing on a full upload with `400 duplicate file ref` when two tasks own a file with the same name.

File refs are now scoped by task id (`<taskId>/<name>`), with an ordinal when one task repeats a name. The previous bare filename was only unique within a task, and the import endpoint requires refs to be unique across the whole request. The bug stayed hidden because push normally sends a delta and skips bytes the server already holds; a full push (for example after recreating a board) sends every file, which is when the collision surfaced.
