---
"@vibeflow-tools/cli": patch
---

Large pushes now pause 5 seconds between chunk uploads, so back-to-back 100-task batch inserts no longer saturate the small server and disturb other users. The pause is skipped before the first chunk and on rate-limit retries that already waited. Override with `pacingDelayMs` (`0` disables).
