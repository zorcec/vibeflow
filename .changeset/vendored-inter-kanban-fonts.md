---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

Serve the kanban board's Inter from vendored woff2 files instead of Google Fonts. The UI package now ships the font files plus the `@font-face` block and the single `KANBAN_FONT_STACK` contract; the CLI serves the same bytes same-origin at `/__vibeflow__/fonts/` and the board HTML no longer references any CDN. Offline or restricted networks previously fell back to a serif face on local boards; both surfaces now resolve the same vendored face with the same stack.
