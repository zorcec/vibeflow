---
"@vibeflow-tools/cli": patch
---

Fix overlay button (corner trigger) not visible on fresh injection after "Hide Vibeflow" was previously used. The hidden state now resets on every fresh page load / bookmarklet injection so the button always appears when the overlay is first mounted.
