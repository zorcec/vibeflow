---
"@vibeflow-tools/cli": minor
---

### Curated themes: Rosé Pine Dawn, Dracula, Gruvbox Dark

- Ship three curated kanban themes alongside dark / light / high-contrast: **Rosé Pine Dawn** (warm paper light), **Dracula** (violet-forward dark) and **Gruvbox Dark** (warm retro dark). Each is a complete, data-only token block in `themes.css` — every `--t-*` token (surfaces, text, borders, accents, status, relations, semantic states, elevation, syntax and the extended chip/control aliases) is declared by the theme, so nothing silently inherits the dark defaults.
- Added a shared **theme registry** (`theme-registry.ts`): theme ids, names, descriptions, light/dark base hints and preview swatches live in one list, and `Theme`/`THEMES` are derived from it. The CLI switcher renders the registry directly, so adding a theme is one registry entry plus one token block — no component edits.
- Added a **theme contract test** that reads `themes.css` and fails if any registered theme is missing a token or drops below the contrast floors (WCAG AA 4.5:1 for body/status/relation/semantic/syntax/accent, 3:1 for the faint/ghost tiers). The pre-existing dark/light sub-floor pairs are frozen explicitly so the shipped themes never regress.
- The default theme is unchanged; dark / light / high-contrast token values are untouched.
