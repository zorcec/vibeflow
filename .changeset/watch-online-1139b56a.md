"@vibeflow-tools/cli": patch
---

`vibeflow watch` now works while logged in: instead of watching local files the logged-in view never touches, it polls for task updates every 15 s by default (`--interval <seconds>`, min 5 s, or `VIBEFLOW_WATCH_INTERVAL_MS`), reusing the same event shapes and ticket banner as local watching. A rejected or expired login now exits non-zero with a re-login hint instead of watching nothing.
