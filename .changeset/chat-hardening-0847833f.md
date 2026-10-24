---
"@vibeflow-tools/cli": patch
---

Agent-chat hardening (behind `VIBEFLOW_FEATURES=CHAT`): each chat session now reaches its own tool server, so the assistant actually has tools. Pasted images travel with the message and images over 2 MiB are skipped with a visible note. Page reads are capped at 4000 characters, browser reads have a 5-second budget with explicit timeout/not-found errors, and the approval gate fails closed for unlisted tools. Login-time push prints already-existed counts and `push --json` includes the `existing` count.
