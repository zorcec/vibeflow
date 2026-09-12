---
"@vibeflow-tools/cli": minor
---

### Theme switcher (CLI kanban)

- Added a **Theme** control to the kanban Settings modal: **System**, **Dark**, **Light** and **High contrast**. The switcher lives in the CLI kanban only — the shared `SettingsModal` gained a generic `appearance` slot, so other consumers of that modal never mount theme UI they did not ask for.
- **System** is a real, selected option: choosing it clears `vibeflow.kanban.theme` (via the shared resolver) so the `prefers-color-scheme` media query decides again, rather than pinning a theme.
- Selecting a theme applies it **immediately** (no reload) and persists it; the choice survives reloads and boots before first paint through `applyInitialTheme()`.
- The control is a native radio group (keyboard + screen-reader operable) with a visible focus ring, and its labels/hints come from the semantic token tier so it is legible in every theme.
- Light theme readability pass for the surfaces the switcher now exposes: card descriptions, filter bar labels/counts, markdown (headings, inline code, links, tables) and badge/tag/status chip text were either pointing at the wrong token or still carrying dark-only hexes. Dark and high-contrast render the same values as before; the new `--t-chip-*`, `--t-text-body`, `--t-control-surface` and `--t-code-bg` tokens pin their dark/hc values to the legacy colours and only change in the light blocks.
