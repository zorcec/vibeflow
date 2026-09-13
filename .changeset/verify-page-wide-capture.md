---
"@vibeflow-tools/cli": patch
---

Fix page-wide verification capture: `vibeflow verify` now runs a self-contained page callback instead of passing helper functions across the Playwright boundary, so `verify-all-styles.json` (and the derived `verify-page-diff.json`) are written again and the page-wide style/HTML query tools work. Evidence-capture failures are now reported instead of being silently swallowed.
