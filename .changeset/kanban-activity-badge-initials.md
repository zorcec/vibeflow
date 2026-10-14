---
"@vibeflow-tools/ui": patch
---

Kanban cards: the live-activity badge no longer prints the full user name (it pushed the comment/file/children actions out of view). It now shows initials in a small circle, reusing the detail panel's presence pattern and per-user hue; crowds collapse to a "+N" chip and the full roster lives in the hover tooltip. The badge cluster never wraps and truncates before the action buttons. Child rows carry the full title as a hover tooltip while the visible text stays ellipsis-truncated.
