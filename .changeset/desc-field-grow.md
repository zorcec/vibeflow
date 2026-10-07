---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

description grows 6→24 rows with preview mirroring the same rows, and the details panel can be resized up to 100% of the viewport

The description edit textarea rests at 6 rows and auto-extends up to 24 rows
(doubled from 12); the preview box mirrors that row range (min 6 / max 24,
converted with its own typography) instead of the fixed 80/220px box, so both
modes show the same number of lines. The panel's manual resize clamp is lifted
from 860px to the viewport width (min 360px kept; saved widths load clamped to
the viewport). Panel and field widths never change with content.
