---
"@vibeflow-tools/cli": patch
---

`verify --pixels` now settles the page before capturing: it waits for `document.fonts.ready` and two animation frames after the storage injection. `animations: "disabled"` freezes animation state but cannot wait for a webfont or the post-injection re-render, so under CPU load an "unchanged" page could diff 24/255 against itself and fail any `--min-pixel-delta` demand. Equal code now means equal pixels.
