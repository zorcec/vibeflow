---
"@vibeflow-tools/ui": patch
---

The child-row status badge now fades out while the row is hovered or keyboard-focused — the same state that reveals the copy-id tab — so the revealed tab is not competing with the badge (3411df56). The badge stays in the DOM (and in the accessibility tree) with its status text and tooltip; only its opacity changes, so no layout shifts.
