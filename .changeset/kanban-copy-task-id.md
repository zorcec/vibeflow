---
"@vibeflow-tools/ui": patch
---

Add a copy-task-id button to kanban task cards

A minimalistic icon in the card's top-right corner copies the task id to the
clipboard, so the detail panel no longer has to be opened just to read it. The
button is hidden until the card is hovered (or reached by keyboard focus), keeps
the card's click behaviour out of the way via stopPropagation, and swaps to a
check mark for 1.2s as copy feedback. Falls back to `execCommand("copy")` when
`navigator.clipboard` is unavailable (plain-http LAN access to the CLI board).
Exposed to tests as `[data-role="copy-id"]`.

Refined for visibility: on card hover the pill lights up with the same hover
background as the tree-toggle chip (22×22, radius 6) so it reads as an active
affordance rather than a ghost icon, and `[data-copied]` turns it green while
the check mark shows.
