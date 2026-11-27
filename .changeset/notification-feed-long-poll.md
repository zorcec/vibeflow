---
"@vibeflow-tools/cli": minor
---

**Notification feed: a follower is woken by an append instead of polling every 2 s.**
`vibeflow notifications --follow` keeps a connection to the board instead of
asking it the same question 30 times a minute:

- `GET /api/notifications?wait=<ms>` **holds** the read open until an event is
  appended or the bound expires — one request per follower per 20 s while the
  board is quiet, with no added delay when something happens.
- The answer carries a `wait` object saying how it ended: `ready` (answered at
  once — first read, a page already waiting, or a gap to report), `event`
  (released by an append), `timeout` (the bound expired). The follower decides
  its transport from that field alone; timing is never used to guess.
- A wait that expires answers an **empty page** with `nextTs` unchanged and
  `gap: false`: a quiet interval is not lost data, so it is never reported as
  one. `nextTs` never advances over anything unseen.
- A held read is only held when the caller already has everything stored, so
  waiting can never delay an event it has not seen.
- **The 2 s poll remains the fallback.** A board that predates this sends no
  `wait` field; the follower then sleeps and polls exactly as before, and the
  local feed still reads `.vibeflow/notifications.jsonl` directly when no board
  is running.
- `--follow`'s help text no longer promises a fixed poll interval.
