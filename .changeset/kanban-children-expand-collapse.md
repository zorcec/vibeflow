---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

Kanban children expand/collapse works on every surface and nested subtrees gain per-node collapse. `TaskCard` falls back to card-local expansion state when no user id is present (static demo, logged-out preview), so the ⤷ chip visibly expands and collapses instead of dead-clicking through the empty-id silent no-op; the compact-view child chip now toggles the persisted expansion (row click still opens the task) instead of only opening it. The CLI board defaults `CURRENT_USER_ID` to `local-viewer` when the server injects none, keeping the chip and unread dot live on the website demo that mounts the same App. `RecursiveChildrenTree` renders a per-node ▾/▸ toggle on every row with children (default expanded, so card expand still reveals the full subtree); collapsing a node hides its nested subtree and depth-limit marker while siblings stay untouched. Flat relation-group mode renders no toggles.
