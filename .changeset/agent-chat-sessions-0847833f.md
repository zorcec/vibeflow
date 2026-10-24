---
"@vibeflow-tools/cli": patch
---

Behind `VIBEFLOW_FEATURES=CHAT`: each chat session now runs one long-lived assistant process, so a conversation keeps context across messages instead of restarting every turn. Idle sessions expire and concurrent sessions are capped. Assistant output is mapped to live UI events for streamed text, tool calls, tool results, and completion.
