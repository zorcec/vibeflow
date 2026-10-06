---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

grow the task description field downward with content instead of widening the detail panel

The earlier content-driven panel auto-grow is reverted: the detail panel keeps
its previous sizing (420–860px, CSS cap `min(860px, 100%)`) and the board keeps
its space. Instead the description field itself extends further down — the
edit-mode textarea drops its row ceiling (no `maxRows` clamp) and the preview
div drops its height cap (min-height kept), so both modes grow with the
description while short descriptions render exactly as before. The details pane
scrolls for overflow. Comment input keeps its existing 10-row / 140px caps.
