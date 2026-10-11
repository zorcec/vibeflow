---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

The board no longer locks a task while someone else has it open

Presence is per-task and says *which part* of the task a person is in (description, comments, files, relations) — a quiet line in the detail panel plus a neutral suffix on the card. Editing is never blocked or disabled: the "🔒 Locked by … — editing disabled" banner, the lock guards and the "locked" activity state are gone. Discrete fields (status, priority, type, title) broadcast and apply for everyone instantly, with no reload.
