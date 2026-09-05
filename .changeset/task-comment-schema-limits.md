---
"@vibeflow-tools/cli": patch
---

Schema validation now enforces max lengths on task titles, descriptions, URLs, and selectors. Oversized fields are rejected with a clear error instead of being silently stored.
