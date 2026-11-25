---
"@vibeflow-tools/cli": minor
---

**Notifications now name the agent that caused a write, and a follower skips its own.**

- Events carry an optional `agent` — `$VIBEFLOW_ACTOR` on local CLI/MCP writes,
  or `X-Vibeflow-Agent` on hosted writes (the hosted event's `actor` stays the
  credential owner). `vibeflow notifications --follow` suppresses an event only
  when its `agent` is exactly the follower's own explicitly-set
  `$VIBEFLOW_ACTOR`; a peer's write and every event without an identity are
  still delivered. `--json` reads stay complete, `actor` alone is never used for
  filtering, and with no `$VIBEFLOW_ACTOR` self-notifications remain (the
  documented residual — silence must never come from an unknown identity).

**Board writes reach the feed.** A comment typed into the local board now
appends a real `task.comment` event (it used to produce only a generic panel
update, so no follower ever saw it). Status/field edits emit
`task.update (changed keys)`; file/screenshot writes keep a panel-level
`task.update`; comment edits/deletes emit nothing by the same rule the hosted
ring already enforces. The CLI `--comment` path still emits exactly one event.

**`serve -p <port>` publishes its port.** The bound port is written to
`.vibeflow/config.json` on startup, so `notifications --follow` finds a board on
a custom port with no extra flag and the Watching badge no longer shows 0 while
an agent is watching.
