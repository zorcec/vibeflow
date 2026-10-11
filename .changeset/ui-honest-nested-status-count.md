---
"@vibeflow-tools/ui": patch
---

Board column headers now state the honest per-status breakdown, and nested child rows carry their own status

A column used to show only its standalone card count (`Review · 5`) while
`tasks --status review` counted every task bearing the status (15), because
children render solely inside their parent's card. The header now reads
`Review · 5 (+10 nested)` whenever tasks with that status render nested
inside parent cards elsewhere, computed from the board's existing task data
(total-by-status minus standalone-by-status, no second fetch); columns with
no nested tasks render exactly as before. The nested figure is reachable via
a hover title on the header count spelling out the breakdown. Board card
child rows additionally show the child's own status badge, so a child in
review nested under an in-progress parent reads as review. The nesting rule,
drag/reparent behaviour, and done-lane fit logic are unchanged.
