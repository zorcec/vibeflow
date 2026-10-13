---
"@vibeflow-tools/cli": patch
---

The injected overlay's paste-to-attach now shows a visible "Processing pasted image…" state the moment a screenshot is pasted in either overlay task form (annotation popover and add-task modal), clearing exactly when the buffered chip renders. A transform failure lands in a visible "Couldn't attach pasted image: …" error box instead of failing silently. Previously both surfaces showed nothing for the seconds the image transform takes, and a failed paste vanished without a word — the same gap the board's detail panel closed in round 1.
