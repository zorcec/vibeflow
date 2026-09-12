---
"@vibeflow-tools/cli": minor
---

Fix kanban drag/order correctness. `tasks --add` and every other create surface now mint a unique, monotonic `sortKey` derived from the store maximum instead of the constant `0000000001000000` that every create collided on (the collision made a card dropped between two such cards jump past both). A new one-time maintenance command, `tasks --reindex-sort-keys` (honors `--dry-run` and `--json`, idempotent, order-preserving), heals the existing keyless and duplicate-key tasks by re-keying them in rendered order while leaving well-formed, store-unique keys untouched. The reindex writes only `sortKey`/`updated` through a byte-preserving path, so legacy fields (such as the singleton `commit`) are never dropped.
