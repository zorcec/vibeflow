---
"@vibeflow-tools/ui": patch
---

Reveal the child-row copy tab only on row hover (3411df56)

The copy tab on a nested child row used to be permanently visible and always
reserved its ~30px at the row's right edge, because its edge style is inline
and inline beats the stylesheet: `.card-copy-id { opacity: 0 }` never applied
and the absolute-positioning rule never took effect. The reveal rule
`.child-link-row:hover .card-copy-id--child` could not match either — the tab
is a SIBLING of `.child-link-row`, not a descendant.

The tab is now collapsed to zero width, invisible and inert at rest, and the
one reveal mechanism is the row's own hover/focus state (ChildRow's
`wrapActive` → `CopyIdButton revealed`). Hovering anywhere on the row, or
tabbing into the tab, restores exactly the approved full-height segment.
Opacity + width are used, never display/visibility, so the tab stays in the
a11y tree and in the tab order. The two dead stylesheet rules were deleted.
