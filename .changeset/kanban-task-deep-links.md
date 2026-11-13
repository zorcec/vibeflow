---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Shareable kanban task deep links: `/kanban/<task-id>` opens the task on the Details tab, with `/activity`, `/details` and `/files` selecting the panel tab (`/comments` is accepted as an alias of `/activity`). Unknown tab slugs fall back to Details and unknown ids render the plain board. The address bar stays in sync (replaceState) when opening, navigating and switching tabs, browser back to `/kanban` closes the panel, and legacy `#task-<id>` hash links keep working with path links taking precedence.
