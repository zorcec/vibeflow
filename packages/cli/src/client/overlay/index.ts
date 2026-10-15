import { OVERLAY_BROWSER_BUNDLE } from "../overlay-bundle.gen.js";

// ── Overlay script entry point ───────────────────────────────────────────────
// The browser-side code lives in src/client/overlay-browser/ and is compiled
// to a self-contained IIFE by tsup. The server prepends PROTO_CONFIG so the
// bundle can access port-specific URLs without string templating.
//
// Server origin detection strategy (handles all injection modes):
//
//  1. Bookmarklet / <script src="..."> injection:
//     document.currentScript.src === "http://localhost:3700/vibeflow-overlay.js"
//     → origin = "http://localhost:3700"
//     This works correctly even when the overlay is clicked on a page with a
//     completely different host (e.g. wsl.localhost, 192.168.x.x, example.com).
//
//  2. Inline injection (CLI serving its own HTML files, or a pasted/eval'd
//     snippet with no script src):
//     document.currentScript has no src → the page's own host is the API
//     only when the ports agree (the CLI serving its own HTML). Otherwise
//     (a snippet evaluated on a foreign page — bookmarklet/console eval,
//     API-only mode) the page host 404s, so keep the page's hostname but
//     use the port this script was generated for. Same-server pages resolve
//     to exactly the old value (localhost:port or LAN IP:port).
export function getOverlayScript(port: number): string {
  const config = `
var _vfScriptSrc = document.currentScript && document.currentScript.src;
var _vfPort = '${port}';
var _vfOrigin = _vfScriptSrc ? new URL(_vfScriptSrc).origin : (window.location.port === _vfPort ? 'http://' + window.location.host : 'http://' + window.location.hostname + ':' + _vfPort);
var PROTO_CONFIG = {
  port: ${port},
  wsUrl: _vfOrigin.replace(/^http/, 'ws'),
  apiUrl: _vfOrigin + '/api/tasks',
  pagesUrl: _vfOrigin + '/api/pages',
  screenshotsUrl: _vfOrigin + '/screenshots/'
};
`;
  return config + OVERLAY_BROWSER_BUNDLE;
}

// ── SaaS overlay script ──────────────────────────────────────────────────────
// Generates the overlay config for SaaS mode. The boardId is read from
// the script tag's data-board-id attribute at runtime by the bundle itself,
// so the script can be served without board-specific URLs.
export function getOverlaySaasScript(baseUrl: string): string {
  const config = `var PROTO_CONFIG = ${JSON.stringify({
    port: 0,
    wsUrl: "",
    apiUrl: `${baseUrl}/api/overlay/tasks`,
    pagesUrl: "",
    screenshotsUrl: "",
  })};\n`;
  return config + OVERLAY_BROWSER_BUNDLE;
}
