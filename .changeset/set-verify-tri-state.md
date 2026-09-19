---
"@vibeflow-tools/cli": minor
---

Add `--set-verify pass|fail|cannot` tri-state flag for task verification. Replaces the old boolean `--verified`/`--verify-failed`/`--unset-verified` with a more expressive system:
- `pass` — task verified correctly
- `fail` — task verified as incorrect  
- `cannot` — task cannot be verified here (records reason)

The `cannot` state is the honest state for unverifiable tasks — it shows no badge and records the reason in task activity.
