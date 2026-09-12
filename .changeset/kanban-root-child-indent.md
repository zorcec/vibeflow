---
"@vibeflow-tools/cli": patch
---

Kanban board: the children tree of a card now starts flush with the card's own content edge. The root level of the tree no longer pays a nesting step — only the levels below it do — so the collapsed tree sits noticeably tighter, while the 14px step between nested levels is unchanged. The detail panel's children tree keeps its root step so its rows stay aligned under the CHILDREN group label, and the depth-8 cap is unaffected.
