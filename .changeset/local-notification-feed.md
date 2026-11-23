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
- Bookkeeping-only writes are **not events**: a patch that only touches
  `updatedAt`/`sortKey`/`rev` produces nothing (a comment-only edit still
  reports `task.comment`), and those keys are stripped from `changed` when a
  real field changes with them. Both backends enforce the same list.
- `VIBEFLOW_EVENTS=0` disables the feature (tests set it so no file is created).

**Read it from the CLI or from an agent.**

```bash
vibeflow notifications [--since <iso>] [--limit <n>] [--json] [--local|--online]
vibeflow notifications --follow [--json] [--exec '<command>']
```

- `--local` reads the project's own log; `--online` reads the linked board's
  `GET /api/v0/notifications` over the same timestamp contract. Neither flag:
  online when the project is linked, local otherwise.
- Human output is one line per event plus a `nextTs:` line (the token for the
  next call); `--json` is the raw envelope and nothing else.
- `--follow` polls every 2 s from the last `nextTs`, printing new events as
  they arrive; with `--exec`, each event is written to the command's stdin as
  one NDJSON line, so any agent or script can subscribe without a client SDK.
- MCP clients get the same feed as `get_notifications({ since?, limit?,
  target? })` — one tool, read-only, with `nextTs` for paging.
- An unparseable `since` is rejected with the expected format
  (`YYYY-MM-DDTHH:mm:ss.sssZ`), a working example, and the reminder that
  omitting `since` returns the newest events.
