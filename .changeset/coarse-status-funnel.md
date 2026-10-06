---
"@vibeflow-tools/cli": patch
---

feat(cli): coarse status transitions and serve mode breakdown in `command_run` analytics

Two instrumentation gaps in the CLI's PostHog `command_run` event:

- `tasks --edit` fires for every mutation but only captured the subcommand
  string, so status transitions (created → in-progress → review → done) were
  indistinguishable in the data. Edit events now carry a coarse
  `from_status` / `to_status` pair — both enum-bounded
  (`backlog | todo | in-progress | review | done`), resolved locally, and
  omitted when the target task cannot be read, so no transition is ever
  fabricated. No task ids, titles, or paths are included.
- `serve` had no mode breakdown, making its usage unanalyzable. Serve events
  now emit `subcommand`: `api` (API-only task server, no target) or
  `prototype` (an HTML target was given). The target path itself never
  reaches analytics.

README telemetry docs updated to document the collected property set, with
regression tests pinning the exact payloads.
