# @vibeflow-tools/ui

## 0.2.0

### Minor Changes

- 148cd3c: Kanban: new Compact view mode (Board | Compact | List). Compact shows one-line rows across all lanes — no tags, no comment/file counts. Done lane fits cards to screen height with "+N more" indicator. Overlay: add-task dialog now has an Advanced section with tag chips and priority selector.
- c57b423: Verify gate: optional enforcement in Settings > Enforcement. When ON, agents must run `vibeflow verify` before setting status to review. Auto-skips for non-UI tasks. `--skip-verify` flag available as bypass.

### Patch Changes

- dbff0c7: fix(ui): align VibeflowIcon bar geometry with brand mark (centered bars, uniform width)

## 0.1.3

### Patch Changes

- cad1cea: feat(kanban): limit done lane to10 items with hidden count indicator

  The done lane now shows a maximum of10 task cards. When there are more than10 done tasks, a dashed-border indicator card appears showing how many tasks are hidden and suggesting to use search to find them. No scrollbar in done lane (overflow-y: hidden).

## 0.1.2

### Patch Changes

- c917033: Increase kanban multi-select long-press timeout to 750ms with drag cancellation

## 0.1.1

### Patch Changes

- df7ecd6: Fix agent picker dropdown closing the detail panel. The outside-click handler on DetailPanel now correctly ignores clicks on the portaled agent picker dropdown, matching the existing behavior for model picker dropdowns and modal backdrops.
- defc6cf: Fix multi-select drag & drop to preserve relative order of selected tasks. Previously, all selected tasks were appended to the column bottom. Now they are inserted at the drop position with correct sort keys computed from the final arrangement. Added e2e Playwright test verifying the behavior.
