---
"@vibeflow-tools/cli": minor
---

### Theming foundation

- The kanban board now renders entirely from the semantic `--t-*` token tier. Every surface, text, border, shadow, status and syntax colour flows through one layer that `themes.css` redefines per theme, so switching `data-theme` (dark / light / hc-dark) reskins the whole board instead of only the values that happened to be overridden.
- Removed the last hardcoded hex colours from the kanban UI — status dots, relation colours, badges, the header gradient, JSON syntax highlighting and the inline `#020c1b` body background now use tokens. Tag pill colours stay a fixed palette (data), independent of the active theme.
- Added a shared theme resolver: `data-theme` is persisted in `localStorage` under `vibeflow.kanban.theme`, validated against the known theme list and SSR-safe. The board boots from the stored preference and otherwise follows the OS `prefers-color-scheme`.
