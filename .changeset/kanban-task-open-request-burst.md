---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Opening a task in the CLI kanban no longer fires a burst of files/comments requests (4 files + 3 comments fetches per open, all 304). `tasks-updated` broadcasts now name what changed (`comments` for comment add/edit/delete, `files`+`comments` for file add/remove which also writes a system trace, `task` for screenshot set/clear), the board refetches the open panel only for named parts with same-tick bursts coalesced to one round, and the detail panel loads with a single comments+files round instead of three badge rounds plus a duplicate files fetch. The kanban API client also stops JSON-parsing body-less (304/empty) responses, returning last-known data instead of throwing.
