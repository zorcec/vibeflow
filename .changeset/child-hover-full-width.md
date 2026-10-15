---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

The child-row hover background now spans the full card width. The hover well is painted on the row wrapper, which used to sit inside the children zone's horizontal padding — so the highlight stopped ~10px/8px short of the card edges. The zone no longer pads horizontally; the inset moved onto the row wrapper, so the well bleeds edge to edge while the row content stays exactly where it was.
