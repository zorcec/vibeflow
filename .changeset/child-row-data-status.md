---
"@vibeflow-tools/ui": patch
---

Relation/child rows expose the child's status as `data-status` on the row root in every variant. The detail panel renders status as a coloured dot only (no badge), so live-update assertions and tooling read the status off the row instead of dot colour. No visual change.
