import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KANBAN_CSS } from "./kanban-css.gen.js";
import { KANBAN_BUNDLE } from "./kanban-bundle.gen.js";

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
}

function getLegacyHtml(port: number): string {
  const found = LEGACY_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error("kanban-template.html not found in expected locations");
  return readFileSync(found, "utf8").replaceAll("__PORT__", String(port));
}

function getSaasModeScript(opts: KanbanOptions): string {
  if (!opts.saasMode) return "";
  return `window.__SAAS_MODE__ = true; window.__BOARD_URL__ = ${JSON.stringify(opts.boardUrl ?? "")}; window.__BOARD_NAME__ = ${JSON.stringify(opts.boardName ?? "")}; window.__IS_ADMIN__ = ${opts.isAdmin ? "true" : "false"};`;
}

// eslint-disable-next-line no-secrets/no-secrets -- base64-encoded SVG favicon, not a credential
const FAVICON_DATA_URI = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxOCAxOCIgZmlsbD0ibm9uZSI+PHJlY3Qgd2lkdGg9IjE4IiBoZWlnaHQ9IjE4IiByeD0iNCIgZmlsbD0iIzI1NjNlYiIvPjxyZWN0IHg9IjIuNSIgeT0iNSIgd2lkdGg9IjIiIGhlaWdodD0iOCIgcng9IjEiIGZpbGw9IndoaXRlIiBvcGFjaXR5PSIwLjciLz48cmVjdCB4PSI2LjUiIHk9IjIiIHdpZHRoPSIyIiBoZWlnaHQ9IjE0IiByeD0iMSIgZmlsbD0id2hpdGUiLz48cmVjdCB4PSIxMC41IiB5PSI2IiB3aWR0aD0iMiIgaGVpZ2h0PSI2IiByeD0iMSIgZmlsbD0id2hpdGUiIG9wYWNpdHk9IjAuNyIvPjxyZWN0IHg9IjE0LjUiIHk9IjQiIHdpZHRoPSIyIiBoZWlnaHQ9IjEwIiByeD0iMSIgZmlsbD0id2hpdGUiIG9wYWNpdHk9IjAuODUiLz48L3N2Zz4=";

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
<body class="h-screen overflow-hidden flex flex-col" style="background:#020c1b;">
  <div id="root"></div>
  <script>window.__PORT__ = ${opts.port}; ${getSaasModeScript(opts)}</script>
  <script>${KANBAN_BUNDLE}</script>
</body>
</html>`;
}

/** Returns the kanban dashboard HTML. Accepts options for SaaS online mode. */
export function getKanbanHtml(port: number): string;
export function getKanbanHtml(opts: KanbanOptions): string;
export function getKanbanHtml(portOrOpts: number | KanbanOptions): string {
  const opts: KanbanOptions = typeof portOrOpts === "number" ? { port: portOrOpts } : portOrOpts;
  if (KANBAN_BUNDLE) return getReactShell(opts);
  return getLegacyHtml(opts.port);
}

