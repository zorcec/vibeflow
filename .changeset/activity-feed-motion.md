---
"@vibeflow-tools/ui": patch
---

The detail panel's activity feed no longer blinks on live updates: rows now carry content-stable keys, so an edited comment or a new message reconciles in place instead of remounting the whole list. New rows slide-fade in (~180ms), in-place text edits earn a brief highlight wash (~600ms), and both animations are skipped entirely under prefers-reduced-motion. Applies to every activity kind (comments, files, status changes, lifecycle entries).
