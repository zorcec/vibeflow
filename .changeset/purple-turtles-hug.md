---
"@vibeflow-tools/cli": minor
---

Expand watch notifications + output modes

- New event types: status, comment, file, priority, description changes
- New output modes: --json (JSONL stdout), --output <file> (append to file), --webhook <url> (POST events)
- New --once mode: one-shot poll with gap detection (>1 min old events trigger gap event)
- State: .vibeflow/watch-state.json (append-only journal, per-consumer cursors, 1-min cap)
- New modules: watch-events.ts, watch-state.ts, watch-sinks.ts
- All existing new/moved-to-todo semantics preserved for backward compat
