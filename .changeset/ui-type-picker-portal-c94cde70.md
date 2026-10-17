---
"@vibeflow-tools/ui": patch
---

Fix the detail-panel type picker opening invisibly inside the title field. The picker's menu rendered inside the `.dp-title-field` wrapper, whose `overflow: hidden` (the approved single-field look) clipped the menu to zero visible pixels — clicking the trigger resolved but showed nothing. The menu now portals to `document.body`, positioned with the shared `computePopoverPosition` helper (the same one the child popover and badge tooltip use), so it anchors to the trigger and stays inside the viewport. The wrapper keeps its overflow and the approved look; Escape closes just the menu, and picking a type no longer closes the panel.
