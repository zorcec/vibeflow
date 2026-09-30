/**
 * Startup guide — the ONE place that knows how to reach a running Vibeflow
 * server and how to put the overlay into an existing app.
 *
 * The same text used to be spelled out inline in three places: two
 * `console.log` blocks in `server.ts` (the API-only `serve()` path and the
 * HTML-target `serve()` path), the HTML on the `/inject` route, and the
 * "✓ Kanban board ready" block the `vibeflow kanban` command prints from
 * `index.ts`. All of them now derive from the builders here, so a URL or an
 * overlay snippet is spelled once.
 *
 * Every builder is PURE: it returns strings/lines and never prints. That is
 * what lets a programmatic caller (the `start_kanban` / `get_integration_guide`
 * MCP tools) get the same data the human CLI prints WITHOUT writing to stdout —
 * under the MCP stdio transport stdout IS the JSON-RPC channel
 * (`src/mcp/stdio.ts`), so a `console.log` here would corrupt the protocol
 * stream. The human path is unaffected: `printGuideLines` is the same
 * `console.log(line)` per line, in the same order, with the same bytes.
 */
import chalk from "chalk";
import { networkInterfaces } from "node:os";

/** Returns the first non-loopback IPv4 LAN address for display when bound to 0.0.0.0. */
function getLanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

/**
 * The display URLs a `(host, port)` pair resolves to.
 *
 * The ONE host→URL rule: bound to `0.0.0.0` the board is shown on the LAN IP
 * AND on localhost ("always dual"); bound to anything else there is no twin.
 * `serve()` and the `start_kanban` dry-run preview both go through here, so a
 * preview names exactly the URLs the real call will serve.
 */
export function resolveDisplayUrl(host: string, port: number): GuideUrls {
  const displayHost = host === "0.0.0.0" ? (getLanIp() ?? "localhost") : host;
  return {
    url: `http://${displayHost}:${port}`,
    localUrl: host === "0.0.0.0" ? `http://localhost:${port}` : null,
  };
}

// ── Banner helpers ─────────────────────────────────────────────────────────

/** The horizontal rule that separates startup-guide sections. */
export function guideDivider(): string {
  return chalk.dim("  " + "─".repeat(62));
}

/** Startup-banner rule: when the server is bound to 0.0.0.0 every user-facing
 * LAN-IP URL must also show its localhost equivalent ("always dual"). Returns
 * the aligned continuation line, or null when bound to a single host so the
 * banner output stays identical to the pre-dual behavior. */
export function localhostAltLine(
  localUrl: string | null,
  path: string,
  indentCols: number,
  label = "",
): string | null {
  if (!localUrl) return null;
  return (
    chalk.dim(" ".repeat(indentCols) + label) + chalk.cyan(`${localUrl}${path}`)
  );
}

/** Localhost equivalent of a yellow <script> tag banner line. */
export function localhostScriptTagAltLine(
  localUrl: string | null,
  indentCols: number,
): string | null {
  if (!localUrl) return null;
  return (
    chalk.dim(" ".repeat(indentCols) + "or: ") +
    chalk.yellow(
      `<script src="${localUrl}/vibeflow-overlay.js" data-vibeflow-overlay></script>`,
    )
  );
}

// ── Guide data ─────────────────────────────────────────────────────────────

/** Where a server lives, and the localhost twin it is also reachable on. */
export interface GuideUrls {
  /** Display base URL — the LAN IP when bound to 0.0.0.0, else the bind host. */
  url: string;
  /** localhost twin of `url`; non-null ONLY when bound to 0.0.0.0. */
  localUrl: string | null;
}

export interface IntegrationGuideOptions {
  /** Board the overlay posts to. Set by the online (SaaS) workspace. */
  boardId?: string;
  /**
   * Base URL serving the overlay script, when it is NOT this server.
   * Online mode: the SaaS origin (`${saasUrl}/api/overlay.js`). The offline
   * `/inject` page: `http://localhost:<port>`, which is what it has always
   * linked to even when the server is bound to 0.0.0.0. Defaults to `url`.
   */
  overlayBaseUrl?: string;
  /**
   * Online mode — tasks post to the SaaS backend, so the CSP-safe
   * fetch+eval form is the primary snippet and the overlay script lives at
   * `${saasUrl}/api/overlay.js` rather than `/vibeflow-overlay.js`.
   */
  online?: boolean;
}

/** Every URL and copy-pasteable snippet a client needs to use the server. */
export interface IntegrationGuide {
  url: string;
  localUrl: string | null;
  kanbanUrl: string;
  taskApiUrl: string;
  /** Page with the bookmarklet + the three integration options, as HTML. */
  injectUrl: string;
  /** The overlay script URL (server-local, or the SaaS origin when online). */
  overlayScriptUrl: string;
  /** localhost twin of `overlayScriptUrl`; non-null only when bound to 0.0.0.0. */
  localOverlayScriptUrl: string | null;
  /** `<script src=… data-vibeflow-overlay>` — the one-line integration. */
  scriptTag: string;
  /** The same tag on the localhost twin; null unless bound to 0.0.0.0. */
  scriptTagLocal: string | null;
  /** Browser-console snippet that loads the overlay. */
  consoleSnippet: string;
  /** `javascript:` URL — drag to the bookmarks bar, click on any page. */
  bookmarkletCode: string;
  boardId: string | undefined;
  online: boolean;
}

/** `<script src=… data-vibeflow-overlay>`, the one-line integration. */
export function overlayScriptTag(
  overlayScriptUrl: string,
  boardId?: string,
): string {
  return `<script src="${overlayScriptUrl}" data-vibeflow-overlay${boardId ? ` data-board-id="${boardId}"` : ""}></script>`;
}

/**
 * THE builder: derives every URL and integration snippet from a base URL.
 *
 * The console banners, the `/inject` page and the MCP tools all read their
 * URLs from here, so "what is the overlay script URL" has one answer.
 */
export function buildIntegrationGuide(
  urls: GuideUrls,
  options: IntegrationGuideOptions = {},
): IntegrationGuide {
  const { boardId, overlayBaseUrl, online = false } = options;
  const overlayScriptUrl = `${overlayBaseUrl ?? urls.url}${
    online ? "/api/overlay.js" : "/vibeflow-overlay.js"
  }`;
  // The dual-URL rule only applies when the overlay is served by THIS server;
  // an explicit overlayBaseUrl (/inject's localhost link, the SaaS origin) is
  // already a single address.
  const localOverlayScriptUrl =
    urls.localUrl && overlayBaseUrl === undefined
      ? `${urls.localUrl}${online ? "/api/overlay.js" : "/vibeflow-overlay.js"}`
      : null;

  const boardIdSetup = boardId ? `window.__PROTO_BOARD_ID='${boardId}';` : "";
  const boardIdSetAttr = boardId
    ? `s.setAttribute('data-board-id','${boardId}');`
    : "";

  return {
    url: urls.url,
    localUrl: urls.localUrl,
    kanbanUrl: `${urls.url}/kanban`,
    taskApiUrl: `${urls.url}/api/tasks`,
    injectUrl: `${urls.url}/inject`,
    overlayScriptUrl,
    localOverlayScriptUrl,
    scriptTag: overlayScriptTag(overlayScriptUrl, boardId),
    scriptTagLocal: localOverlayScriptUrl
      ? overlayScriptTag(localOverlayScriptUrl, boardId)
      : null,
    // Online: the overlay posts to SaaS, so it is loaded with fetch + eval
    // (survives `script-src` CSP). Offline: a <script> element is enough.
    consoleSnippet: online
      ? `${boardIdSetup}fetch('${overlayScriptUrl}').then(r=>r.text()).then(code=>eval(code));`
      : `var s=document.createElement('script');s.src='${overlayScriptUrl}';s.setAttribute('data-vibeflow-overlay','');${boardIdSetAttr}document.head.appendChild(s);`,
    bookmarkletCode: online
      ? `javascript:(function(){if(document.getElementById('vibeflow-studio-root')){alert('Vibeflow overlay is already active.')}else{${boardIdSetup}fetch('${overlayScriptUrl}').then(function(r){return r.text()}).then(function(code){eval(code)}).catch(function(){alert('Failed to load Vibeflow overlay')})}})()`
      : `javascript:(function(){if(document.getElementById('vibeflow-studio-root')){alert('Vibeflow overlay is already active on this page.');}else{var s=document.createElement('script');s.src='${overlayScriptUrl}';s.setAttribute('data-vibeflow-overlay','');${boardIdSetAttr}document.head.appendChild(s);}})()`,
    boardId,
    online,
  };
}

// ── Console rendering (the human CLI path) ─────────────────────────────────

/** Prints each line in order. Byte-identical to the inline `console.log` blocks
 * this module replaced — one `console.log` per entry, empty string included. */
export function printGuideLines(lines: string[]): void {
  for (const line of lines) console.log(line);
}

/** "  BOARDS & APIS" — the kanban board and the task API endpoints. */
export function buildBoardsAndApisLines(guide: IntegrationGuide): string[] {
  const lines = [chalk.bold.white("  BOARDS & APIS")];
  lines.push(chalk.dim("  Kanban board    ") + chalk.cyan(guide.kanbanUrl));
  const kanbanAlt = localhostAltLine(guide.localUrl, "/kanban", 18);
  if (kanbanAlt) lines.push(kanbanAlt);
  lines.push(chalk.dim("  Task API        ") + chalk.cyan(guide.taskApiUrl));
  const taskApiAlt = localhostAltLine(guide.localUrl, "/api/tasks", 18);
  if (taskApiAlt) lines.push(taskApiAlt);
  return lines;
}

/**
 * "INTEGRATE INTO YOUR APP" — the section both `serve()` paths print, and the
 * section the MCP tools hand back as instructions. Leading divider included so
 * callers can splice it in directly.
 */
export function buildIntegrateIntoAppLines(guide: IntegrationGuide): string[] {
  const lines = [guideDivider()];
  lines.push(
    chalk.bold.white("  INTEGRATE INTO YOUR APP") +
      chalk.dim(`  (full guide: ${guide.injectUrl})`),
  );
  const guideAlt = localhostAltLine(guide.localUrl, "/inject", 40);
  if (guideAlt) lines.push(guideAlt);
  lines.push(chalk.dim("  1. Add this script tag to your HTML:"));
  lines.push(chalk.dim("     ") + chalk.yellow(guide.scriptTag));
  const scriptAlt = localhostScriptTagAltLine(guide.localUrl, 5);
  if (scriptAlt) lines.push(scriptAlt);
  lines.push(
    chalk.dim("  2. Reload your page — the overlay appears automatically."),
  );
  lines.push(chalk.dim("  3. Click anything to annotate it."));
  return lines;
}

/** "Bookmarklet — no code changes needed". */
export function buildBookmarkletLines(guide: IntegrationGuide): string[] {
  const lines = [
    guideDivider(),
    chalk.dim("  Bookmarklet — no code changes needed:"),
    chalk.dim("  Visit and drag the bookmarklet from ") +
      chalk.cyan(guide.injectUrl) +
      chalk.dim(" to your bookmarks bar."),
  ];
  const injectAlt = localhostAltLine(guide.localUrl, "/inject", 2, "or: ");
  if (injectAlt) lines.push(injectAlt);
  return lines;
}

/** Online mode's boxed "Add to your HTML" alternative to the numbered steps. */
export function buildOnlineAddToHtmlLines(guide: IntegrationGuide): string[] {
  const lines: string[] = [
    chalk.dim("  ┌─ Add to your HTML ") + chalk.dim("─".repeat(43) + "┐"),
    chalk.dim("  │ ") + chalk.yellow(guide.scriptTag) + chalk.dim(" │"),
  ];
  if (guide.scriptTagLocal) {
    lines.push(
      chalk.dim("  │ or: ") + chalk.yellow(guide.scriptTagLocal) + chalk.dim(" │"),
    );
  }
  lines.push(
    chalk.dim("  │ ") +
      chalk.dim("Or drag the bookmarklet: ") +
      chalk.cyan(guide.injectUrl) +
      chalk.dim("         │"),
  );
  if (guide.localUrl) {
    lines.push(
      chalk.dim("  │ or: ") +
        chalk.cyan(`${guide.localUrl}/inject`) +
        chalk.dim("         │"),
    );
  }
  lines.push(chalk.dim("  └" + "─".repeat(63) + "┘"));
  return lines;
}

/**
 * The "✓ Kanban board ready" block the `vibeflow kanban` command prints and
 * `start_kanban` returns. Includes the leading and trailing blank lines and
 * the agent prompt, so both callers emit the same run of `console.log`s.
 */
export function buildKanbanReadyLines(guide: IntegrationGuide): string[] {
  const lines = [
    "",
    chalk.green("  ✓ Kanban board ready"),
    chalk.dim("    ") + chalk.cyan(guide.kanbanUrl),
  ];
  if (guide.localUrl) {
    lines.push(chalk.dim("    ") + chalk.cyan(`${guide.localUrl}/kanban`));
  }
  lines.push(
    "",
    chalk.bold("Agent prompt:"),
    chalk.dim(
      "  Get new tasks and implement them, once done check again for new ones:",
    ),
    chalk.dim("  ") + chalk.green("npx @vibeflow-tools/cli tasks --next"),
    "",
    chalk.dim("  Press Ctrl+C to stop"),
    "",
  );
  return lines;
}

// ── Plain-text rendering (the MCP path) ────────────────────────────────────

/**
 * The same instruction block, ANSI-free, for a machine consumer.
 *
 * Deliberately NOT the console lines above: a tool payload must not carry
 * terminal escapes, and the callers (a chat client, an agent) render text, not
 * a terminal. The CONTENT is the same guide data.
 */
export function buildGuideText(
  guide: IntegrationGuide,
  options: { serverRunning: boolean } = { serverRunning: true },
): string {
  const out: string[] = [];
  out.push(`Kanban board: ${guide.kanbanUrl}`);
  if (guide.localUrl) out.push(`Local: ${guide.localUrl}/kanban`);
  out.push(`Task API: ${guide.taskApiUrl}`);
  if (!options.serverRunning) {
    out.push("");
    out.push(
      "The kanban server is NOT running — the URLs above assume the default " +
        "port and no server has been started. Call start_kanban first, then " +
        "re-read the guide for the real URLs.",
    );
  }
  out.push("");
  out.push(`INTEGRATE INTO YOUR APP (full guide: ${guide.injectUrl})`);
  out.push("1. Add this script tag to your HTML:");
  out.push(`   ${guide.scriptTag}`);
  if (guide.scriptTagLocal) out.push(`   or: ${guide.scriptTagLocal}`);
  out.push("2. Reload your page — the overlay appears automatically.");
  out.push("3. Click anything to annotate it.");
  out.push("");
  out.push("Bookmarklet — no code changes needed:");
  out.push(
    `  Visit and drag the bookmarklet from ${guide.injectUrl} to your bookmarks bar.`,
  );
  out.push(`  (bookmarklet href: ${guide.bookmarkletCode})`);
  out.push("");
  out.push("Agent prompt:");
  out.push(
    "  Get new tasks and implement them, once done check again for new ones:",
  );
  out.push("  npx @vibeflow-tools/cli tasks --next");
  return out.join("\n");
}
