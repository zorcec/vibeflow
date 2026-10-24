---
"@vibeflow-tools/cli": patch
---

`--normalize --apply --dry-run` is now a true preview: `--dry-run` overrides `--apply`, like every other operation. Previously the maintenance write ran despite the dry-run flag.
