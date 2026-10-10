---
"@vibeflow-tools/cli": patch
---

Fix WebSocket broadcast starvation: a per-socket send failure (e.g. a client that just disconnected) no longer aborts the broadcast loop or escapes into the mutation handler as a spurious "Failed to broadcast task event" warning. Each socket send is guarded individually so one dead client can never prevent the remaining clients from receiving the event.
