---
"@vibeflow-tools/cli": minor
---

**`vibeflow setup` — install the CLI's agent integration.**

```bash
vibeflow setup                       # id | detected | installed | version | support
vibeflow setup pi [--project] [--force] [--check] [--dry-run] [--json]
vibeflow setup claude|codex [--check] [--json]
```

- `setup pi` writes a self-contained pi extension to
  `~/.pi/agent/extensions/vibeflow-notifications.js` (`--project` installs into
  `.pi/extensions/` instead) and follows **the project it was installed for**
  (passed as the child's `cwd`; `VIBEFLOW_NOTIFY_PROJECT` overrides it), so a
  session started in a parent directory with its own `.vibeflow` no longer
  follows that unrelated local store. It follows `vibeflow notifications --follow
  --json` — the backend resolves exactly as it does in the terminal (online for
  a linked project, local otherwise; forcing `--local` made it silent in every
  online project) — and injects one line per task event —
  `task <taskId> <type> (<changed>)` — so an agent notices work that landed
  while it was busy and fetches the detail itself with `vibeflow tasks --get
  <id>`. `/vibeflow-status` reports the connection, the last event, and the
  events seen this session; `run /reload in pi` picks up a fresh install.
- Every installed file carries a `// vibeflow-cli: <version>` first line, so
  `setup pi --check` answers "is this extension from the CLI I am running?"
  and exits non-zero when it is missing or stale. `--json` reports the same
  answer as one object (`installed`, `version`, `drift`, `path`, `actions`).
- `claude` and `codex` are listed and detected but reported as planned: they
  answer `ok: true` and write nothing, pointing at the integration that works
  for any agent today — `vibeflow notifications --follow --exec '<command>'`.
