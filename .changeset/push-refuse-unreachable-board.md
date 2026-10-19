---
"@vibeflow-tools/cli": patch
---

`vibeflow push` now refuses up front when the saved board is no longer
reachable, instead of attempting every local task.

A board-scope rejection (HTTP 401/403/404) from the board listing is not a
transient failure, but the push treated it as one: it fell back to "Could
not read the board — attempting push of all local tasks" and fired a create
per task at a board that no longer existed. Every write was refused, so the
progress bar counted attempts while nothing landed anywhere.

The push now stops before the first write, prints that the board is not
accessible (deleted, or the token belongs to another account), exits
non-zero, and points at `vibeflow auth login`. Only genuine transport
failures keep the old "attempt everything, say so" fallback.
