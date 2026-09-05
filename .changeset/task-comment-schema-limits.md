---
"@vibeflow-tools/cli": patch
---

Bound string lengths on shared task/comment schemas (audit WP3): oversized fields are now rejected with a validation error instead of being silently stored. Titles, descriptions, URLs, selectors, and agent/model metadata each get a sensible max length (e.g. description 10_000, url 2_000, selector 1_000).
