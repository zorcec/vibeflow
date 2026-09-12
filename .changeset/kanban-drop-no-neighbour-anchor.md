---
"@vibeflow-tools/cli": patch
---

fix(kanban): anchor a no-neighbour drop to the store max, not the initial constant

A drag that had no neighbour in its target column — a parented task dropped on
an empty column, or a task reordered when it is its parent's only child — called
`computeReorder` with no before/after key. That fell through to
`generateSortKeyBetween(null, null)`, the store's initial constant
`0000000001000000`, which another task already owned (`fd1ddc21`), minting a
cross-column duplicate and pinning the dropped card to the top of its column.

`computeReorder` now accepts the store's highest key as an append anchor, used
only when both neighbours are absent; the card, column and tree drop paths pass
it (`maxSortKey` over the loaded tasks). An empty store still mints the initial
key, as before. Adds `maxSortKey` to the shared kanban utils and regression
tests for the empty-column, only-child and mixed-width-fractional cases.
