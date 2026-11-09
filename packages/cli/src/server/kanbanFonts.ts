/**
 * Vendored Inter serving for the local board (ticket rrqdvoqkj5).
 *
 * The woff2 bytes live in `@vibeflow-tools/ui` (`src/kanban/fonts/`, the
 * single source of truth); this module resolves them on disk and exposes
 * the same-origin route the shared `@font-face` block points at
 * (`KANBAN_FONT_ROUTE`). Mirrors `imageNodeCodecs.ts` / the codec route:
 * allowlisted filenames only (no directory listing, no traversal), long
 * cache (immutable versioned binaries).
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import {
  KANBAN_FONT_FILES,
  KANBAN_FONT_ROUTE,
  type KanbanFontFile,
} from "@vibeflow-tools/ui/kanban";

export { KANBAN_FONT_ROUTE };
export type { KanbanFontFile };

/** Allowlist guard: only the vendored Inter files are servable. */
export function isKanbanFontFile(name: string): name is KanbanFontFile {
  return (KANBAN_FONT_FILES as readonly string[]).includes(name);
}

function findFontAsset(name: KanbanFontFile): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Published CLI: the font-asset script copies the binaries next to the bundles.
    join(here, "..", "client", "fonts", name),
    join(here, "..", "..", "client", "fonts", name),
    // Flat dist/ bundle layout (dist/index.js entry, chunks beside it).
    join(here, "client", "fonts", name),
    // Source checkout after a build (tests, dev server).
    join(here, "..", "..", "dist", "client", "fonts", name),
    // Source checkout without a build: the workspace UI package owns the files.
    join(here, "..", "..", "..", "ui", "src", "kanban", "fonts", name),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`kanban font not found: ${name}`);
}

/** Absolute disk path of a vendored Inter file (server route + prebuild copy). */
export function kanbanFontPath(name: KanbanFontFile): string {
  return findFontAsset(name);
}

/**
 * Serves the vendored Inter woff2 binaries (`/__vibeflow__/fonts/<name>`)
 * the inlined board CSS references via `@font-face`. Pure immutable bytes —
 * long-cacheable. The allowlist rejects everything else (no directory
 * listing, no traversal).
 */
export function registerFontRoute(app: express.Application): void {
  app.get(`${KANBAN_FONT_ROUTE}/:name`, (req, res) => {
    const { name } = req.params;
    if (!isKanbanFontFile(name)) {
      res.status(404).end();
      return;
    }
    let filePath: string;
    try {
      filePath = kanbanFontPath(name);
    } catch {
      res.status(404).end();
      return;
    }
    // Path is allowlisted to the five known binaries resolved by
    // kanbanFontPath() — no user-controlled traversal (nosemgrep).
    res.set("Content-Type", "font/woff2");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(filePath);
  });
}
