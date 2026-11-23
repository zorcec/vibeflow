---
"@vibeflow-tools/cli": minor
"@vibeflow-tools/ui": minor
---

**The "Watching" badge — who is following this board's notification feed.**

A compact pill in the board header (`Watching N`, next to the existing action
pills) counts the agents currently subscribed to the board's notification feed.
Clicking it opens a breakdown of `user — N agents`. It is read-only; a browser
tab is never counted as a watcher.

**A subscriber is an explicit follower**, not a socket:

- `vibeflow notifications --follow` registers on start, heartbeats every 30 s,
  and unregisters on Ctrl-C (`SIGINT`/`SIGTERM`) and on a failed feed read — a
  `finally`-style exit, so a killed follower never leaves a ghost.
- Liveness is a 90 s TTL: a follower that dies without a clean exit disappears
  from the badge within the TTL. Nothing is persisted; a server restart starts
  at 0 (the same visible trade the event ring documents).
- `subscriberId` is random per follower process; `agent` is `$VIBEFLOW_ACTOR`
  when set, else `agent`; the user label is the authenticated account's name
  (else email) on the hosted board, and `local` on the local board.

**Routes (both surfaces, 1:1):**

- Hosted: `GET|POST /api/v0/notifications/subscribers`,
  `DELETE /api/v0/notifications/subscribers/:id` (`tasks:read` + board scope).
- Local: `GET|POST /api/notifications/subscribers`, same DELETE, no auth (the
  local board's existing rule). The badge reads the local board's route; the
  hosted board passes `X-Vibeflow-Scope`.

`POST` is also the heartbeat (`{ subscriberId, agent }`); `GET` answers
`{ total, byUser: [{ user, agents }], byAgent: [{ agent, count }] }`; `DELETE`
is idempotent (`{ removed, total }`) so a retrying follower is not an error.
