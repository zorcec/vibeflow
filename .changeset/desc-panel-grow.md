---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

feat(kanban): grow the detail panel with the description up to 75% of the viewport

The detail panel now measures the rendered description's max-content width and
auto-grows to fit it — up to 75% of the viewport (while always leaving the board
its own band) — with the previous panel width as the floor, so short
descriptions render pixel-identically to before. Manual resize, saved-settings
validation and the CSS cap share one ceiling function; a saved width above the
ceiling is clamped rather than dropped, and growth never shrinks the panel below
the user's width on small viewports. Mirrors the same panel logic in the web app
as a follow-up.
