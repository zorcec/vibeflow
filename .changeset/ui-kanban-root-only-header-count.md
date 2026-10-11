---
"@vibeflow-tools/ui": patch
---

Show only the root-card count in kanban column headers

Column headers render the count of root/standalone cards actually shown in
that column (e.g. `Review · 2`). The old `(+N nested)` suffix is gone from
the visible header text. Nothing is hidden: columns with nested tasks show
a subtle `↳ N nested` hint chip beside the count, and both the count and
the chip carry a hover title (`N tasks have status X: R shown as cards, M
nested inside parent cards in other columns`) plus an aria-label, so the
numbers still reconcile against every task carrying the status. Child
status badges inside parent cards are unchanged.
