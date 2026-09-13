---
"@vibeflow-tools/cli": patch
---

Fix the verify style diff: the annotation baseline and the verify-time capture now use the same `RELEVANT_STYLES` property set, and the diff compares only properties recorded on both sides. Previously verify captured every computed style (~476 in chromium) against a 62-property baseline, so a no-op page reported ~437 false `"" → value` changes and buried the real ones.
