---
"@vibeflow-tools/cli": patch
---

Page baselines are stored compact with one style map per element. The annotation capture fills `baseline` and `after` with identical values, so `baseline-page.json` carried every element's styles twice and pretty-printed (~1.68 MB for a 364-element page, now ~0.64 MB). The server strips the duplicate map and writes compact JSON; verify and the style query tools read `.after` and back-fill `.baseline` from it, so results are unchanged.
