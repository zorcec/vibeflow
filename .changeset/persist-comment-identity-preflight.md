---
"@vibeflow-tools/cli": patch
---

Persist deterministic ids for historical comments before pushing tasks, and stop with the task id and reason if a record cannot be repaired. The same repair is available through `tasks --normalize --apply`; existing comment ids are preserved.
