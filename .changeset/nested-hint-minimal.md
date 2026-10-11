---
"@vibeflow-tools/ui": patch
---

Kanban column headers show the nested-task hint as the bare count (`↳ 7`) instead of a bordered pill reading `↳ 7 nested`, and the pill's border/padding/background are gone (93f10f06). The explanation is unchanged and still available on hover (title) and to screen readers (aria-label), so nothing is lost beyond the visual weight.
