---
"@vibeflow-tools/ui": patch
---

Kanban column headers now count the children owned by the column's cards, regardless of the children's own status. A parent in Review with 3 children renders "Review · 1 ↳ 3"; a child whose parent sits in another column counts in the parent's column, never in its own status column.
