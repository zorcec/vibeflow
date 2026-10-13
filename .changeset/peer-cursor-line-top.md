---
"@vibeflow-tools/ui": patch
---

Peer cursors in the task description now sit on the text like real carets: the position marker measured the text baseline, so the caret hung a full line-height below the glyphs and its name flag landed on top of neighbouring text. The marker now measures the line-box top, the flag always hugs from above, and the overlay is split into a clipped mirror layer plus an unclipped caret layer (out-of-view carets are culled) so first-line flags float over the editor chrome instead of being cut off. Full names stay on hover title and screen-reader label.
