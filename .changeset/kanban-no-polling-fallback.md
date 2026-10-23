---
"@vibeflow-tools/cli": patch
---

Remove the kanban polling fallback. A dropped socket no longer starts a 5-second task poll; the board re-reads once on reconnect and every change in between arrives over the socket. Reconnect now backs off exponentially (2s to 30s, jittered) instead of retrying every 2 seconds forever.
