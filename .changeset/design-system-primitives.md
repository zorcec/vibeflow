---
"@vibeflow-tools/cli": minor
---

The kanban UI is a design system: tokens, primitives and utilities replace the
hand-written component CSS.

What a CLI user sees: the board, the detail panel and the overlay render from
one token set, so all six themes (dark, light, hc-dark, rose-pine-dawn, dracula,
gruvbox-dark) restyle every surface consistently. The stylesheet pipeline moved
to Tailwind v4, the board CSS is compiled from an explicit `@source` set instead
of a config file, and the overlay's shadow-root styling is inlined from the
same token source.

What does not change: task data, the CLI surface, drag-and-drop results, the
`data-*` hooks the browser suite binds to, and the persisted theme preference.

New primitives exported from the package: `Button`, `Badge`, `Input`,
`Textarea`, `Dialog`, `Popover`, `Tooltip`, `Select`, `Tabs` — each with a story
matrix and six-theme accessibility coverage.
