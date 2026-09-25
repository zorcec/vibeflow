import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KANBAN_CSS } from "./kanban-css.gen.js";
import { KANBAN_BUNDLE } from "./kanban-bundle.gen.js";
import { getCurrentUserId } from "../core/tasks.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LEGACY_CANDIDATES = [
  join(__dirname, "kanban-template.html"),
  join(process.cwd(), "src", "server", "kanban-template.html"),
  join(process.cwd(), "dist", "server", "kanban-template.html"),
];

export interface KanbanOptions {
  port: number;
  saasMode?: boolean;
  boardUrl?: string;
  boardName?: string;
  isAdmin?: boolean;
  /** Installed CLI version — drives the "What's New" modal; omitted when unknown. */
  cliVersion?: string;
}

function getLegacyHtml(port: number): string {
  const found = LEGACY_CANDIDATES.find((p) => existsSync(p));
  if (!found)
    throw new Error("kanban-template.html not found in expected locations");
  return readFileSync(found, "utf8").replaceAll("__PORT__", String(port));
}

/** One line, emitted at most once per process when a rebuild landed after
 * the board process started — the served HTML still inlines the old copy. */
export const STALE_BUNDLE_WARNING =
  "[vibeflow] kanban: board serves a STALE inlined bundle — the bundle on " +
  "disk was rebuilt after this process started, so the served HTML still " +
  "contains the old JavaScript. Rebuild and restart the board process " +
  "(a browser reload alone will not pick up the fix).";

/** mtime of one file the inlined bundle was loaded from (null = not on disk). */
export interface BundleFileMtime {
  path: string;
  mtimeMs: number | null;
}

function statMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Files providing the inlined bundle: the generated bundle module when it
 * exists on disk (source/vitest runs), otherwise the bundled file this module
 * was loaded from (dist — a rebuild rewrites or removes it). */
function bundleSourcePaths(): string[] {
  const gen = [
    join(__dirname, "kanban-bundle.gen.js"),
    join(__dirname, "kanban-bundle.gen.ts"),
  ].filter((p) => existsSync(p));
  return gen.length > 0 ? gen : [fileURLToPath(import.meta.url)];
}

/** Bundle mtimes recorded when this module loaded — the "inlined" copy. */
const INLINED_BUNDLE_MTIMES: BundleFileMtime[] = bundleSourcePaths().map(
  (path) => ({ path, mtimeMs: statMtime(path) }),
);

/** True when a rebuild landed after the bundle was inlined: a watched file is
 * newer than the mtime recorded at load, or disappeared (a dist rebuild
 * replaced the file this module was loaded from). */
export function isBundleStale(
  inlined: readonly BundleFileMtime[],
  disk: readonly BundleFileMtime[],
): boolean {
  const diskByPath = new Map(disk.map((f) => [f.path, f.mtimeMs]));
  return inlined.some((f) => {
    if (f.mtimeMs === null) return false; // never on disk — nothing to compare
    const now = diskByPath.get(f.path) ?? null;
    return now === null || now > f.mtimeMs;
  });
}

let staleBundleWarned = false;

/** Emits {@link STALE_BUNDLE_WARNING} at most once per process when the bundle
 * on disk is newer than the copy inlined at load. Called on every board HTML
 * serve, but only stat()s and warns until the stale condition is hit. */
export function warnIfBundleStale(
  opts: {
    log?: (msg: string) => void;
    inlined?: readonly BundleFileMtime[];
    disk?: readonly BundleFileMtime[];
  } = {},
): boolean {
  if (staleBundleWarned) return false;
  const inlined = opts.inlined ?? INLINED_BUNDLE_MTIMES;
  const disk =
    opts.disk ??
    inlined.map((f) => ({ path: f.path, mtimeMs: statMtime(f.path) }));
  if (!isBundleStale(inlined, disk)) return false;
  (opts.log ?? console.warn)(STALE_BUNDLE_WARNING);
  staleBundleWarned = true;
  return true;
}

function getSaasModeScript(opts: KanbanOptions): string {
  if (!opts.saasMode) return "";
  return `window.__SAAS_MODE__ = true; window.__BOARD_URL__ = ${JSON.stringify(opts.boardUrl ?? "")}; window.__BOARD_NAME__ = ${JSON.stringify(opts.boardName ?? "")}; window.__IS_ADMIN__ = ${opts.isAdmin ? "true" : "false"};`;
}

// base64-encoded SVG favicon, not a credential
const FAVICON_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxOCAxOCIgZmlsbD0ibm9uZSI+PHJlY3Qgd2lkdGg9IjE4IiBoZWlnaHQ9IjE4IiByeD0iNCIgZmlsbD0iIzI1NjNlYiIvPjxyZWN0IHg9IjIuNSIgeT0iNSIgd2lkdGg9IjIiIGhlaWdodD0iOCIgcng9IjEiIGZpbGw9IndoaXRlIiBvcGFjaXR5PSIwLjciLz48cmVjdCB4PSI2LjUiIHk9IjIiIHdpZHRoPSIyIiBoZWlnaHQ9IjE0IiByeD0iMSIgZmlsbD0id2hpdGUiLz48cmVjdCB4PSIxMC41IiB5PSI2IiB3aWR0aD0iMiIgaGVpZ2h0PSI2IiByeD0iMSIgZmlsbD0id2hpdGUiIG9wYWNpdHk9IjAuNyIvPjxyZWN0IHg9IjE0LjUiIHk9IjQiIHdpZHRoPSIyIiBoZWlnaHQ9IjEwIiByeD0iMSIgZmlsbD0id2hpdGUiIG9wYWNpdHk9IjAuODUiLz48L3N2Zz4=";

function getReactShell(opts: KanbanOptions): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vibeflow — Board</title>
  <link rel="icon" href="${FAVICON_DATA_URI}" type="image/svg+xml">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${KANBAN_CSS}</style>
</head>
<body class="h-screen overflow-hidden flex flex-col" style="background:var(--t-bg);">
  <div id="root"></div>
  <script>window.__PORT__ = ${opts.port}; window.__CLI_VERSION__ = ${JSON.stringify(opts.cliVersion ?? "")}; window.__VIBEFLOW_USER__ = ${JSON.stringify(getCurrentUserId())}; ${getSaasModeScript(opts)}</script>
  <script>${KANBAN_BUNDLE}</script>
</body>
</html>`;
}

/** Returns the kanban dashboard HTML. Accepts options for SaaS online mode. */
export function getKanbanHtml(port: number): string;
export function getKanbanHtml(opts: KanbanOptions): string;
export function getKanbanHtml(portOrOpts: number | KanbanOptions): string {
  const opts: KanbanOptions =
    typeof portOrOpts === "number" ? { port: portOrOpts } : portOrOpts;
  if (KANBAN_BUNDLE) {
    warnIfBundleStale();
    return getReactShell(opts);
  }
  return getLegacyHtml(opts.port);
}
