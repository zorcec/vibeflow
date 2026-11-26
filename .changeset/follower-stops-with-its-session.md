---
"@vibeflow-tools/cli": patch
---

A watcher now stops when the session that started it goes away, instead of staying on the "Watching" list forever.

Closing the harness (or the terminal) left the `notifications --follow` process orphaned: it was reparented, kept heartbeating, and the badge kept listing an agent that was long gone. Three ways a follower could die without unregistering are now handled:

- **SIGHUP** — what a closed terminal or a dying parent actually sends, and Node's default for it is to exit *without* running handlers, so the unregister never happened.
- **Being orphaned** — the follower remembers its parent pid and stops if it changes, which is exactly what happens when pi is closed or hard-killed.
- **A broken stdout pipe** — a dead reader used to throw `EPIPE` as an uncaught error, killing the process with a stack trace and no unregister.

All three take the graceful path, so the badge drops to zero immediately instead of waiting out the 90 s subscriber TTL.

A watcher that must outlive its parent belongs under a supervisor, where the parent pid is a real supervisor.
