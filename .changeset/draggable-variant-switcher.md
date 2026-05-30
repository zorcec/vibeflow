---
"@vibeflow-tools/ui-prototyping": patch
---

Make `VariantSwitcher` draggable — same hold-to-drag behaviour as the vibeflow corner trigger. Hold the indicator dot for 300ms, then drag to reposition anywhere on the viewport. Position is persisted to `localStorage` per scope name (`vf-variant-pos-<name>`), so it survives page reloads. Cursor changes to `grab` on hold and `grabbing` during drag for clear affordance.
