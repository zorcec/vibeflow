---
"@vibeflow-tools/cli": minor
---

**Notification feed: server-side subscription filters and an honest `filteredCount`.**
`GET /api/notifications` now narrows the page itself instead of making every
follower download events it will discard:

- `?taskId=`, `?type=`, `?status=`, `?agent=` — repeatable across dimensions,
  ANDed, each a single token. A task-scoped read matches every event of that
  task; `status` matches what the event announces (a creation's `to.status`, a
  claim's destination).
- The answer gains `filteredCount` = events inside the time window the
  subscription dropped, next to `count` (returned) and `truncated` (matched but
  paged out). `count: 0, filteredCount: 7` reads as "7 things you chose not to
  see" — counts, never silence.
- `nextTs` is the **read cursor**, not "the newest event in the page": it stops
  at the oldest filtered event, so changing the filter later can still reach
  events the cursor never passed. An unfiltered read is unchanged.
- `nextTs` is therefore pinned while a filter keeps dropping events. If the
  500-event cap evicts the pinned event, the existing `gap` warning reports it.
- An unknown dimension (a param this board does not read) **widens** — it is
  never a constraint and never an error, so a newer client against an older
  board sees more than it asked for, never less. A well-formed value that names
  something the board never emits narrows to zero, explicitly.
- An invalid value for a known dimension is `400 INVALID_FILTER` with the same
  envelope shape and actionable example as `INVALID_SINCE`.
- Filters are per read: the cursor is still just a timestamp, so nothing is
  stored client-side.
