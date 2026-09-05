---
"@vibeflow-tools/cli": patch
---

Fix verify gate: skip enforcement when no baseline.json exists

Auto-created log-cluster tasks have selector+url but no baseline screenshot. The verify gate now checks baseline.json existence before blocking review.
