---
"@vibeflow-tools/ui": patch
---

Kanban cards: the badge-overflow fit no longer re-measures after every render, and it measures a width it cannot
itself influence. Previously `remeasure()` ran from a layout effect with no dependency array and derived the
available width from the badge cluster's own `clientWidth` — a body the cluster sizes from its content — so any
measurement that failed to settle could set state for ever and React would abort with "Maximum update depth
exceeded" (#185). The available width now comes from the footer row minus its non-cluster children (stable
regardless of the fit), and the effect is dependency-scoped. Badge fitting behaviour is unchanged.
