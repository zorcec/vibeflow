---
"@vibeflow-tools/cli": patch
---

Fix overlay corner trigger rendering off-screen when a position saved on a larger monitor is restored from localStorage. The saved coordinates are now clamped to the current viewport bounds on load, so the button is always visible regardless of screen size changes.
