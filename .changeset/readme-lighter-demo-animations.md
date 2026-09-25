---
"@vibeflow-tools/cli": patch
---

Use distinct animated GIF demo images in the README. GitHub and npm render animated WebP as a static first frame, so the previous embeds showed stills (before that, both image slots pointed at the same 2 MB GIF, so "See It in Action" just repeated the hero animation). The hero now loads a 7.4 s board-and-drag walkthrough (`showcase-hq.gif`, 2.96 MB) and the section loads a different 9.9 s walkthrough covering drag, parent/child expansion and the full ticket (`board-flow-hq.gif`, 5.11 MB) — full-frame 1600×1000 at 12.5 fps, both under GitHub camo's 5 MB cap, and the two slots show different clips.
