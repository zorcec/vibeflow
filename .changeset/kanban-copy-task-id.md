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

Extended to child task rows on the board (inline card-zone tree and
children popover): hovering a child row reveals the same copy-id pill — same
icon, same click-to-copy with check feedback — parked at the row's right
edge. The detail-panel rows are unchanged. The card-level hover reveal is
scoped so hovering a card no longer lights up its children's pills.

### Highlights

- Copy a task's id straight from the board: a hover-revealed pill on the card — and now on child rows too — copies the id to your clipboard with a green check as feedback, so the detail panel never has to be opened just to read it.
