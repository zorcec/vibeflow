<!-- highlight -->
---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Cold-load needs-attention parity. A task flagged BEFORE the board opened showed a plain reason comment and no attention row — the diff-event path only records the row on live transitions. The Activity tab now derives ONE amber attention row from the current `needsAttention` state at render (a live transition row still wins, never two rows) and marks the reason comment the flag is linked to with the same amber wash, in card detail and navigated-child contexts.
