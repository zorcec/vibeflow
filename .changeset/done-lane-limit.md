---
"@vibeflow-tools/ui": patch
---

feat(kanban): limit done lane to10 items with hidden count indicator

The done lane now shows a maximum of10 task cards. When there are more than10 done tasks, a dashed-border indicator card appears showing how many tasks are hidden and suggesting to use search to find them. No scrollbar in done lane (overflow-y: hidden).
