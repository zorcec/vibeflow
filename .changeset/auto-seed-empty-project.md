<!-- markdownlint-disable MD041 -->
---
"@vibeflow-tools/cli": patch
---

A fresh, empty project gets demo data on its first local board.

`vibeflow kanban` in a folder that is not a project yet used to refuse; in an
initialised but empty store it showed a silent blank board. Both now land on a
populated example:

- A folder with no `.git` and no `.vibeflow/` gets one created, with a loud
  one-line notice naming the path.
- A store with zero tasks is seeded with the same 13 example cards as
  `vibeflow demo` (all statuses, three linked sub-tasks, comments, an
  attachment, one URL+selector card, two verified done cards).
- It happens **once per project**: a marker (`demo-seed.json`) decides, so
  deleting the samples does not bring them back, and a project that already has
  any task is never touched.
