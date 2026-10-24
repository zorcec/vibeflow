---
"@vibeflow-tools/cli": patch
---

Bound every board request with an explicit deadline (30s by default, 120s for file uploads, 3s for the settings check) covering headers and body. A stalled response now fails with a timeout naming the operation phase instead of hanging the command, and `tasks --add` reports the phase for a timed-out create.
