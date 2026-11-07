---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Needs-attention bell breathes a glow instead of flickering. The `attention-breathe` animation moved from the `.attention-indicator` wrapper (which dimmed the whole bell to 0.45 opacity) to the bell svg itself: the amber drop-shadow swells to ~5px/0.5 alpha and fades over a slow ~3s ease-in-out cycle while the glyph stays fully opaque. Static under `prefers-reduced-motion`.
