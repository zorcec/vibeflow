---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/prototyping": patch
---

Add unused-symbol detection and remove dead code.

Internal only — no runtime behaviour change. The repo previously had no ESLint, so `tsc --noEmit` never flagged unused imports/locals. A single `@typescript-eslint/no-unused-vars` rule now gates unused symbols for `pnpm lint`, unused symbols in the CLI and prototyping sources were removed, and three unreferenced UI files (`Board.tsx`, `TaskCard.tsx`, `TaskList.tsx`) were deleted.
