---
"@vibeflow-tools/cli": patch
---

Use lighter, distinct animated WebP demo images in the README. Both image slots previously pointed at the same 2 MB GIF, so the "See It in Action" section just repeated the hero animation. The hero now loads a 7.4 s board-and-drag walkthrough (109 KB) and the section loads a different 9.9 s walkthrough covering drag, parent/child expansion and the full ticket (225 KB) — roughly 12x less image data across the README, and the two slots no longer show the same clip.
