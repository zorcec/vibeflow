---
"@vibeflow-tools/cli": patch
---

Online mode P1 (ticket 7339393c): `TaskStore` boundary with a
`LocalTaskStore` adapter delegating 1:1 to the existing file-backed
`core/tasks.ts`, `core/comments.ts`, and `core/files.ts` functions.
Behaviour-neutral — no call site changed, no selection logic; P2/P3
(remote reads, then remote writes) gain the one place to change.
