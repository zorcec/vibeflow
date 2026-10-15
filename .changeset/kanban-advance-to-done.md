---
"@vibeflow-tools/ui": patch
---

The card hover advance control now reaches Done: cards in Review show a "Move to Done" chevron that travels the same column-drop status path as every other lane (board `onDrop` → `patchTask` → `api.updateTask`), so lane guards apply unchanged. Done stays terminal and renders no control.
