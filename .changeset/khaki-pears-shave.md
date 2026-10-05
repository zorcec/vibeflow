---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

fix(ui): stop the DetailPanel title autofocus from stealing focus, and add test hooks

The detail panel focused its title input from a bare `setTimeout(…, 50)` inside an effect
keyed on `[open, task?.id, tab]`, so it fired on every task *and* tab change, unconditionally.
Two real bugs followed:

- Open a task and click the Tags input, and 50 ms later focus jumped back to the title —
  mid-click, mid-typing.
- Worse, whatever was typing then delivered its characters to the title. In the web e2e suite
  this silently renamed tasks ("Tag Test Task" → "Tag Test Taskmy-new-tag") roughly one run in
  three, and persisted the rename. The autofocus now skips whenever focus already sits on a
  control inside the panel, so the panel still focuses the title on open but never takes focus
  away from a user.

Covered by a new regression guard,
`packages/ui/src/kanban/components/__tests__/DetailPanel.title-focus.test.tsx`.

Also adds the stable test hooks the parent-links e2e spec was already written against but which
did not exist: `data-role="task-card"`, `data-role="relation-group-rows"`, `data-role="detail-panel"`,
`data-role="child-count"`, and `data-child-chip` on the card's child chip. Tag pills gain
`data-testid="tag-pill"` / `data-tag="<tag>"`, because a text lookup for a tag is ambiguous — the
same string appears in the pill, on the card, and inside the "task saved" toast.

`vibeflow status` no longer exits 0 when it cannot reach the SaaS backend, and no longer reports
"Could not reach SaaS backend" for the two cases that are not network failures (a revoked token,
and a request that never had a board selected). A new `--json` flag emits the standard envelope
for scripts. `status` is now classified as intentionally-unexposed MCP surface, since the flag
has no MCP counterpart.