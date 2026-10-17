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
  /**
   * Kanban dev mode (ticket 7e85c338): serve the on-disk bundle as a
   * separate no-store asset + live-reload on rebuild, instead of the
   * production inlined megastring. EXPLICIT opt-in only — never default.
   * Falls back to `VIBEFLOW_DEV=1` when omitted, so `tsup --watch` +
   * `VIBEFLOW_DEV=1 vibeflow serve` works without a CLI flag.
   */
  dev?: boolean;
}

/**
 * Dev-mode bundle asset route (ticket 7e85c338). Served with
 * `Cache-Control: no-store` so the browser re-fetches the freshly rebuilt
 * bytes after every live-reload — never a cached copy of the old bundle.
 */
export const KANBAN_DEV_BUNDLE_ROUTE = "/__vibeflow__/kanban-dev.js";

/**
 * WebSocket message type that tells dev-mode boards to `location.reload()`
 * after a rebuild (ticket 7e85c338). A dedicated type on the EXISTING task-sync
 * socket: the channel (ws) is reused, but data sync (`tasks-updated` /
 * `task-changed`) and code reload never share a frame shape or handler.
 */
export const KANBAN_RELOAD_MESSAGE_TYPE = "kanban-reload";

/** Env var that enables kanban dev mode without the `--dev` CLI flag. */
export const KANBAN_DEV_ENV_VAR = "VIBEFLOW_DEV";

/**
 * Test seam (ticket 7e85c338): absolute path to the dev bundle file,
 * bypassing the $CANDIDATE search below. Set by dev-mode tests so they can
 * point the server at a temp marker file instead of the real dist bundle.
 */
export const KANBAN_DEV_BUNDLE_PATH_ENV_VAR = "VIBEFLOW_KANBAN_DEV_BUNDLE";

/**
 * True only when kanban dev mode was EXPLICITLY requested (ticket 7e85c338):
 * either `explicit === true` (the `--dev` CLI flag threaded through
 * `ServeOptions.dev` → `KanbanOptions.dev`) or `VIBEFLOW_DEV=1` in the
 * environment. Never true by default — production stays exactly the
 * single-file inlined bundle.
 */
export function isKanbanDevMode(explicit?: boolean): boolean {
  if (explicit === true) return true;
  const env = process.env[KANBAN_DEV_ENV_VAR];
  return env === "1" || env === "true";
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

/**
 * Candidate locations of the freshly built kanban bundle on disk (ticket
 * 7e85c338). `tsup --watch` rewrites `dist/client/kanban-browser.js` on
 * every kanban client edit; dev mode serves THOSE bytes per request instead
 * of the inlined copy baked at server start. Order: test-seam env override
 * first, then the dist layout (both the package-cwd and repo-root-cwd
 * spellings, since vitest runs from packages/cli while e2e harnesses may
 * run from the repo root), then the source-tree spelling.
 */
export function resolveKanbanDevBundlePath(): string | null {
  const override = process.env[KANBAN_DEV_BUNDLE_PATH_ENV_VAR]?.trim();
  if (override) return override;
  const found = [
    join(__dirname, "..", "client", "kanban-browser.js"),
    join(process.cwd(), "dist", "client", "kanban-browser.js"),
    join(process.cwd(), "packages", "cli", "dist", "client", "kanban-browser.js"),
  ].find((p) => existsSync(p));
  return found ?? null;
}

/** On-disk dev bundle bytes, or null when no built bundle exists. */
export function readKanbanDevBundle(): { path: string; bytes: string } | null {
  const path = resolveKanbanDevBundlePath();
  if (!path) return null;
  try {
    return { path, bytes: readFileSync(path, "utf8") };
  } catch {
    return null;
  }
}

/** Loud refusal when dev mode has no built bundle to serve (ticket 7e85c338).
 * Dev must never silently serve old code: no bundle on disk is a 500 with
 * the fix (`tsup --watch` / `pnpm dev`), not an empty page. */
export const KANBAN_DEV_BUNDLE_MISSING =
  "[vibeflow] kanban dev mode: no built bundle found on disk — run the " +
  "watching build first (`pnpm --filter @vibeflow-tools/cli dev`, i.e. " +
  "`tsup --watch`) and keep it running alongside the dev server. " +
  "Refusing to serve a stale/missing bundle.";

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

/**
 * Dev-mode board shell (ticket 7e85c338): references the on-disk bundle via
 * {@link KANBAN_DEV_BUNDLE_ROUTE} (no-store) instead of inlining
 * `KANBAN_BUNDLE`, so `tsup --watch` rebuilds are picked up with NO server
 * restart. The inline snippet opens a SECOND websocket beside the React
 * app's task-sync socket and reloads the page when the server broadcasts
 * {@link KANBAN_RELOAD_MESSAGE_TYPE} after a rebuild. A separate socket
 * (not a hook inside App.tsx) keeps data sync and code reload unentangled:
 * the reload fires even when the bundle itself is broken and React never
 * boots. Full-page LIVE RELOAD only — no React Refresh state preservation
 * (stretch goal, not shipped: a full reload is deterministic and cannot
 * leave stale module state behind, which is exactly what a dev loop needs).
 */
function getReactDevShell(opts: KanbanOptions): string {
  const missing = readKanbanDevBundle() === null;
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vibeflow — Board (dev)</title>
  <link rel="icon" href="${FAVICON_DATA_URI}" type="image/svg+xml">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${KANBAN_CSS}</style>
</head>
<body class="h-screen overflow-hidden flex flex-col" style="background:var(--t-bg);">
  <div id="root"></div>
  ${missing ? `<!-- ${KANBAN_DEV_BUNDLE_MISSING} -->` : ""}
  <script>window.__PORT__ = ${opts.port}; window.__CLI_VERSION__ = ${JSON.stringify(opts.cliVersion ?? "")}; window.__VIBEFLOW_USER__ = ${JSON.stringify(getCurrentUserId())}; window.__VIBEFLOW_DEV__ = true; ${getSaasModeScript(opts)}</script>
  <script src="${KANBAN_DEV_BUNDLE_ROUTE}"></script>
  <script>(function(){try{var p=window.location.protocol==="https:"?"wss:":"ws:";var ws=new WebSocket(p+"//"+window.location.host);ws.addEventListener("message",function(ev){try{var msg=JSON.parse(ev.data);if(msg&&msg.type===${JSON.stringify(KANBAN_RELOAD_MESSAGE_TYPE)}){window.location.reload();}}catch(e){/* keep the dev socket alive */}});}catch(e){console.error("[vibeflow] kanban dev live-reload socket failed",e);}})();</script>
</body>
</html>`;
}

/** Returns the kanban dashboard HTML. Accepts options for SaaS online mode. */
export function getKanbanHtml(port: number): string;
export function getKanbanHtml(opts: KanbanOptions): string;
export function getKanbanHtml(portOrOpts: number | KanbanOptions): string {
  const opts: KanbanOptions =
    typeof portOrOpts === "number" ? { port: portOrOpts } : portOrOpts;
  // Dev mode is EXPLICIT (ticket 7e85c338): the `--dev` flag threaded
  // through KanbanOptions.dev, or VIBEFLOW_DEV=1 in the environment.
  // Production (default) keeps the exact single-file inlined bundle.
  if (isKanbanDevMode(opts.dev)) {
    if (readKanbanDevBundle() === null)
      console.error(KANBAN_DEV_BUNDLE_MISSING);
    return getReactDevShell(opts);
  }
  if (KANBAN_BUNDLE) {
    warnIfBundleStale();
    return getReactShell(opts);
  }
  return getLegacyHtml(opts.port);
}
