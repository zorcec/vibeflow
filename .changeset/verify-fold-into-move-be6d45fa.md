---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

Activity feed: a save that moves a task into review (the verification stage) while attesting a verdict now reads as ONE event — the move row carries the Pass/Fail badge, and the companion "changed verify: none → verified" row is folded away instead of splitting the save in two. Standalone attestations (no status move), moves into lanes that draw no verdict, and verdict clears keep their own `verify` row, which is the only record of the verdict there. Rows recorded before this change render exactly as before. Field-change entries are in-session only — a board reload starts with no field rows, as before.
