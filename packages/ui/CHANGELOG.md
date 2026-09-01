# @vibeflow-tools/ui

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
