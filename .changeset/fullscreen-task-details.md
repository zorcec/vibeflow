---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Task details can open fullscreen, persisted as a global preference

The detail-panel header gains a fullscreen toggle (expand/restore) next to the
close button, mirrored by an "Open task details fullscreen" checkbox in the
settings Board tab. The `panelFullscreen` flag persists through the existing
settings round-trip (CLI settings JSON allowlist; web tRPC blob needs no
backend change) and applies to every opened task on both surfaces. Fullscreen
renders as a fixed viewport overlay class so the saved `panelWidth` is
preserved verbatim for an exact restore; the resize handle hides while
fullscreen and Escape/X still close the panel.
