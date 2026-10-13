/**
 * Local API docs viewer (Phase 1).
 *
 * Serves GET /api/docs — a Swagger UI page rendering the checked-in
 * contract as served at GET /api/openapi.json — plus its two vendored
 * assets (no CDN, so the board works offline). The assets are embedded at
 * author time from swagger-ui-dist (scripts/embed-swagger-ui.mjs) into
 * swagger-ui.gen.ts, so the served bytes are identical in tests and in the
 * published bundle with no runtime file resolution.
 *
 * Deliberate decision (ticket): the page does NOT auto-inject any
 * credential. "Try it out" sends only what the user pastes under
 * Authorize, exactly like a third-party integrator. Locally reads need no
 * token (loopback trust) and a pasted bearer token is sent but ignored.
 */

import type { Express } from "express";
import {
  SWAGGER_UI_BUNDLE_JS,
  SWAGGER_UI_CSS,
  SWAGGER_UI_VERSION,
} from "./swagger-ui.gen.js";

/** Long-cacheable: the asset URLs carry the vendored version (?v=...). */
const IMMUTABLE = "public, max-age=31536000, immutable";

function buildDocsHtml(): string {
  const v = SWAGGER_UI_VERSION;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vibeflow API v1 — docs</title>
<link rel="stylesheet" href="/api/docs/swagger-ui.css?v=${v}">
<link rel="icon" href="data:,">
<style>
.vf-docs-note{font-family:system-ui,sans-serif;font-size:13px;line-height:1.5;
color:#334155;background:#f1f5f9;border-bottom:1px solid #e2e8f0;
padding:10px 16px;margin:0}
.vf-docs-note code{background:#e2e8f0;padding:1px 5px;border-radius:4px;
font-size:12px}
.vf-docs-note a{color:#2563eb}
</style>
</head>
<body>
<p class="vf-docs-note">Local board API docs — rendered from
<a href="/api/openapi.json"><code>/api/openapi.json</code></a> (the checked-in
contract, served verbatim).Reads need no token on this machine; “Try it out”
sends only what you paste under <strong>Authorize</strong> — this page never
injects a credential by itself.</p>
<div id="swagger-ui"></div>
<script src="/api/docs/swagger-ui-bundle.js?v=${v}"></script>
<script>
window.onload = function () {
  SwaggerUIBundle({
    url: "/api/openapi.json",
    dom_id: "#swagger-ui",
    presets: [SwaggerUIBundle.presets.apis],
    layout: "BaseLayout",
    deepLinking: true,
    docExpansion: "list",
    defaultModelsExpandDepth: 1
  });
};
</script>
</body>
</html>
`;
}

/** Mount the viewer. Offline branches only — online mode serves no local API. */
export function registerDocsViewer(app: Express): void {
  app.get("/api/docs", (_req, res) => {
    // The client HTML is generated per process start like /kanban — a
    // cached copy would outlive a restart and pin a stale asset version.
    res.set("Cache-Control", "no-store");
    res.type("html").send(buildDocsHtml());
  });
  app.get("/api/docs/swagger-ui-bundle.js", (_req, res) => {
    res
      .type("application/javascript")
      .set("Cache-Control", IMMUTABLE)
      .send(SWAGGER_UI_BUNDLE_JS);
  });
  app.get("/api/docs/swagger-ui.css", (_req, res) => {
    res.type("text/css").set("Cache-Control", IMMUTABLE).send(SWAGGER_UI_CSS);
  });
}
