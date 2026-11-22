---
"@vibeflow-tools/cli": minor
---

**Local notification feed.** Every local task mutation now appends one event to
`.vibeflow/notifications.jsonl` (gitignored, capped at 500, best-effort — a
notification never fails the write it describes), and the board serves it:

- `GET /api/notifications?since=<iso>&limit=<n>` → `{ notifications, nextTs,
  earliestTs, gap, truncated, count }`.
- `since` is an **inclusive** ISO timestamp: at-least-once delivery, so the
  boundary event may repeat but can never disappear. Pass the previous
  response's `nextTs` as the next `since`.
- Events are deliberately minimal — `{ id, ts, type, taskId, actor, changed?,
  to? }` — so a consumer fetches details from `vibeflow tasks --get <id>`
  instead of receiving the whole record.
- Emitted from one seam per surface: the CLI's tool wrapper (`tasks --add`,
  `--edit`, `--next`), the MCP dispatch every MCP transport shares, and the
  board's own task-scoped broadcasts (`actor: "board"`).
- `VIBEFLOW_EVENTS=0` disables the feature (tests set it so no file is created).
