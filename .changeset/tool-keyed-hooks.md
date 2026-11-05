---
"@vibeflow-tools/cli": minor
---

Agent hooks v2: one hook file per TOOL instead of per internal event — `tasks.after.mjs`, `kanban.after.mjs`, `create_task.before.mjs`, … covering every CLI command and all 13 MCP tools; the hook envelope is `schemaVersion: 2` with `tool`/`surface` and `phase: before|after` (the `pre` vocabulary is gone), and an invocation with no durable effect narrates once with `activity: null`. Shipped defaults are now read in place from the installed package (`dist/hooks/defaults/`, trusted, upgraded by `npm update`) instead of being copied into `~/.vibeflow/hooks/defaults/` — that directory is obsolete. Policies are unchanged: 2 s per invocation, before fail-closed, after fail-open, stdout purity, PATH/HOME-only child env, project-hook trust, `--no-verify` audit.
