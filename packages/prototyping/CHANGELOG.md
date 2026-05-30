# @vibeflow-tools/prototyping

## 0.2.0

### Minor Changes

- Add `@vibeflow-tools/prototyping` React package for in-app variant switching. Provides `useVariant`, `useActiveVariant`, `VariantProvider`, `PageVariantSwitcher`, `VariantSwitcher`, and `VariantDevToolbar` components with URL param and localStorage persistence, keyboard shortcuts (Alt+H / Ctrl+Shift+V, configurable), overlay integration (MutationObserver + polling for bookmarklet injection), and zero runtime dependencies.

### Patch Changes

- c525ae7: Make `VariantSwitcher` draggable — same hold-to-drag behaviour as the vibeflow corner trigger. Hold the indicator dot for 300ms, then drag to reposition anywhere on the viewport. Position is persisted to `localStorage` per scope name (`vf-variant-pos-<name>`), so it survives page reloads. Cursor changes to `grab` on hold and `grabbing` during drag for clear affordance.
- Add production-ready README with full API reference, quick start, persistence docs, keyboard shortcuts, and Vibeflow overlay integration guide.
