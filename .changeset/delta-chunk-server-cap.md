---
"@vibeflow-tools/cli": patch
---

Fixed delta push failing with `400 BATCH_TOO_LARGE` on any push of more than 100 changed tasks: the delta chunker allowed 200 tasks per archive request while the server's `POST /api/v0/tasks/import/archive` caps at `V0_IMPORT_MAX_TASKS` (= 100). `DELTA_CHUNK_MAX_TASKS` is now 100, so a 123-task push travels as 100+23 instead of one refused request.
