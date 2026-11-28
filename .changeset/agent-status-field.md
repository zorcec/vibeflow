---
"@vibeflow-tools/cli": minor
---

An agent can now tell the board what it is doing — one free-text status line in the Watching popover, with no new event type and nothing persisted.

`vibeflow agents status "<text>"` posts the report onto the subscriber identity the follower already registers (`status: { text, at }`, text truncated to 140 chars, never rejected); `vibeflow agents status --clear` removes it. The status lives on the same in-memory row as the follower: a heartbeat that omits it preserves it (unlike `activity`/`current`, which still clear on absence), the explicit `null` clears it, and it dies with the row at the 90 s heartbeat TTL — a status can never outlive the process it describes. With no live follower the command refuses with `E_USAGE` (exit 2) and posts nothing; the route answers `409 NO_LIVE_AGENT` if the row expired in between. The one-shot update never refreshes `lastSeenAt`, so it cannot resurrect a dead follower's row.
