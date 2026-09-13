---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Move the kanban theme picker into its own Settings tab and strip it back to a compact swatch grid. The shared `SettingsModal` now renders the `appearance` slot in a dedicated tab named by the surface (`appearanceTab`) instead of appending it to the bottom of the Board tab, so the modal stays appearance-agnostic and other consumers keep their two tabs. Each choice is now one chip — the registry preview swatch plus the theme name — with the per-option descriptions reduced to a native tooltip and the group hint moved to screen-reader-only text; keyboard navigation, focus visibility, radio semantics and the selected state (a check on the active chip) are unchanged.
