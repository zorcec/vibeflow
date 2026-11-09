/**
 * Kanban font contract (ticket rrqdvoqkj5) — ONE stack, served the same way
 * on the local board and the hosted app.
 *
 * WHAT: the Inter woff2 files vendored next to this module
 * (`./fonts/inter-<weight>.woff2`, SIL Open Font License — see OFL.txt) are
 * the only Inter source for every kanban surface. The `@font-face` block at
 * the top of `kanban.css` points at them via {@link KANBAN_FONT_ROUTE}; the
 * CLI serves that route from these same bytes and the hosted app serves it
 * from `public/` copies of these same bytes — so both boards compute the
 * SAME {@link KANBAN_FONT_STACK} string and resolve the SAME face.
 *
 * WHY one module: a previous worker found the UI referenced Inter by name
 * only (no `@font-face`, no file) while the local board pulled it from
 * Google Fonts at runtime — offline/blocked networks fell back to a serif
 * face, the exact "a font failed to load" impression the owner reported on
 * local only. Never fetch Inter from a CDN again: a deploy/board gate must
 * not depend on a third-party fetch (same reason the hosted app vendors
 * instead of `next/font/google`).
 */
export const KANBAN_FONT_FAMILY = "Inter" as const;

/**
 * The single font stack for every kanban surface (local board body CSS and
 * hosted `globals.css` body rule must carry this EXACT string — the parity
 * test fails on any drift). Inter first for the designed look; the system
 * chain after it is the graceful fallback, never a serif.
 */
export const KANBAN_FONT_STACK =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Same-origin route both servers expose the vendored woff2 files at. */
export const KANBAN_FONT_ROUTE = "/__vibeflow__/fonts" as const;

/** Vendored weights — the `@font-face` block, the CLI route allowlist, and
 * the hosted `public/` dir must carry exactly these files. */
export const KANBAN_FONT_FILES = [
  "inter-300.woff2",
  "inter-400.woff2",
  "inter-500.woff2",
  "inter-600.woff2",
  "inter-700.woff2",
] as const;

export type KanbanFontFile = (typeof KANBAN_FONT_FILES)[number];
