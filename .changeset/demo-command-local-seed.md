---
"@vibeflow-tools/cli": patch
---

`vibeflow demo` — a populated demo board in one command, no project needed.

The hosted app seeds a demo board for a fresh account, but the CLI showed the
user's real (usually empty) store, so a first run looked like the tool did
nothing. `vibeflow demo` seeds a fixed demo store at `~/.vibeflow-demo` (never
your project, never your cwd — so it runs from any directory, with or without
`.git`) and boots the board on it.

- 13 cards across all five statuses, 3 sub-tasks linked to their parent, tags
  and priorities, a two-party comment thread, one attachment, one card
  annotated with a real URL + selector, and two done cards carrying evidence.
- Re-running is a no-op while the seed version matches; `--reset` wipes and
  reseeds. `-p/--port`, `--host` and `--no-open` match `vibeflow kanban`.
- Prints one "what to try next" line, and the demo store path, so demo data is
  never mistaken for real work.
