---
"@vibeflow-tools/cli": patch
---

Fix a stale `.sortkey-ceiling` sidecar: after `--reindex-sort-keys` (which deletes the sidecar) the next `updateTask` re-seeded the monotonic ceiling from the single task it had just written. When that task did not sort last, the following `tasks --add` minted `thatKey + gap` and landed mid-store instead of appending. `updateTask` now rescans for the true store max via `maxStoreSortKey` when the cache is absent, matching the create path.
