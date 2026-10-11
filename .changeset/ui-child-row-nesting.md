---
"@vibeflow-tools/ui": patch
---

Fix invalid HTML on the kanban board: child-row buttons nested inside the row button

`ChildRow` rendered its root as a native `<button>` while carrying two
interactive children (the copy-id pill and the Unlink button), which React
flags as `validateDOMNesting: <button> cannot appear as a descendant of
<button>` and which made the row depend on `stopPropagation` shims for
correct click/focus behaviour. The row root is now a `div` with `role="button"`,
`tabIndex={0}` and Enter/Space handling, so the inner buttons are legal
siblings; every behaviour is preserved (row click/keyboard open, expansion
toggle, hover/keyboard-lit copy-id that copies, link/unlink, status badge,
row drag) and every kept `stopPropagation` is a genuine bubbling/drag guard.
