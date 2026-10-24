---
"@vibeflow-tools/ui": patch
---

The board search box now propagates on a 150ms trailing debounce instead of re-rendering on every keystroke, while the input echo stays instant.
