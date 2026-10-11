---
"@vibeflow-tools/ui": patch
---

Redesign the child-row copy affordance as a full-height right-edge segment

The copy-id control on child rows was a small floating pill parked over the
row padding. It now renders as a full-height tab attached to the row's right
edge inside a dedicated actions strip: faint glyph at rest so it reads as
part of the row, lit well on row hover and on keyboard focus, green
well while the "copied" check shows. The Unlink control joins it as a second
full-height segment, still hover/focus-revealed. The row root and the
actions strip are siblings inside a `.child-row-wrap`, so no interactive
element nests inside another — neither native button-in-button nor
button-inside-`div[role=button]`. Whole-row click, Enter/Space activation,
row drag/drop, depth dimming, and the child status badge are unchanged.
