---
"@vibeflow-tools/cli": minor
"@vibeflow-tools/ui": minor
---

The task description is now a live, shared document

Two people can type in the same description at the same time without losing text: edits merge character by character (a CRDT document per task, synced over the existing realtime socket) and each session sees the other's cursors and selection. The document is seeded from the saved description and written back through the same board-scoped write path the rest of the board uses, so how the description is stored and read does not change. Cursors appear in the description only; elsewhere the quiet presence line already shows who is present and where.
