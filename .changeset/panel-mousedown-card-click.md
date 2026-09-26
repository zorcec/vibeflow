---
"@vibeflow-tools/cli": patch
---

Fix the detail panel disappearing when you press the mouse on a task card, and harden the file-preview URL check.

A mousedown on a task card used to be treated as a click outside the panel, so the panel closed on mouse-down — before the click itself. Closing it also collapses the board's reserved right inset, so every card reflowed mid-gesture and the click could land on a different element, making the card you pressed never open. A card press is no longer an outside click: the click that follows decides which task is shown, and a pending comment still prompts before anything is dismissed.

The file-preview guard now resolves the URL against the page origin instead of comparing string prefixes, closing two off-origin cases (`/\evil.com` and a tab-split `//evil.com`) that passed the prefix test and resolved to an external host.
