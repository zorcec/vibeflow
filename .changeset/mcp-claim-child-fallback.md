---
"@vibeflow-tools/cli": patch
---

`claim_next_task` now follows the same roots-first rule as `vibeflow tasks --next`: when no todo root is
claimable it falls back to the highest-priority matching todo child and says so explicitly (a `CHILD_CLAIM`
notice naming the parent), instead of reporting "nothing to claim" while the CLI claimed the child on the
same board. Roots are still always preferred; the manifest description now documents the fallback.
