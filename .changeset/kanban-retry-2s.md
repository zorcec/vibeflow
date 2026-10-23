---
"@vibeflow-tools/cli": patch
---

Keep the 2-second reconnect retry (no backoff) now that the polling fallback is gone; the retry is the only thing that restores a dropped board, and each reconnect costs one board read rather than a loop.
