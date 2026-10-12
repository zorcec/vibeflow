---
"@vibeflow-tools/ui": patch
---

Collaborative caret flag shows initials instead of the full name

The remote-caret name flag spelled out the peer's full name in a wide solid box that covered the line above the text. It now shows the peer's initials (the same helper as the presence chips) in a compact label that hugs the caret, keeping the per-user colour. The full name is still on hover and exposed to screen readers, and the 2px caret itself is unchanged.
