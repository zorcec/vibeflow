---
"@vibeflow-tools/cli": patch
---

Batch push reports re-push matches honestly (ticket 9309ea70). Servers
now return `{ id, existing: true }` for tasks already on the board; the
CLI fills the idMap from them (links heal) but counts them separately —
a pure re-push prints "0 created, N already existed" instead of
claiming N created.
