---
"@vibeflow-tools/ui": patch
---

The children hover preview now has breathing room on its left edge: popover rows render with the 10px left padding the stylesheet always intended, instead of the 2.5px tree-indent base that overrode it inline and pinned row text edge-flush. Tree and detail-panel rows are unchanged.
