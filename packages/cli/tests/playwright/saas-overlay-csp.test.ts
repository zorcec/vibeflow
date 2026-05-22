/**
 * Playwright e2e tests for the SaaS overlay CSP-safe injection.
 *
 * Reproduces the bug where the CLI's /inject page bookmarklet used
 * createElement('script') pointing to http://localhost which violates
 * "script-src 'self' 'unsafe-inline' 'unsafe-eval'" CSP directives.
 *
 * Verifies that in SaaS mode:
 *   1. The bookmarklet uses fetch+eval (not createElement('script'))
 *   2. The bookmarklet URL points to the HTTPS SaaS origin, not localhost
 *   3. The overlay script has empty wsUrl (no localhost WebSocket connection)
 *   4. Loading the overlay on a CSP-restricted page produces no CSP errors
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const SAAS_BASE_URL = "https://app.vibeflow.ai";
const BOARD_ID = "board-csp-test-123";
const PORT = 3913;
const BASE = `http://localhost:${PORT}`;

// Mock workspace passed via ServeOptions._testWorkspace to simulate SaaS auth.
// This avoids vi.mock hoisting issues in forks pool.
const MOCK_WORKSPACE = {
  id: BOARD_ID,
  name: "Test Board",
  url: `${SAAS_BASE_URL}/kanban?board=${BOARD_ID}`,
};

// ── HTML page with strict CSP (mimics a real production app) ─────────────────
// script-src 'self' 'unsafe-inline' 'unsafe-eval' allows eval() but NOT
// external script URLs from different origins. connect-src allows https: and
// same-origin but NOT http://localhost.
const CSP_RESTRICTED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CSP-restricted App</title>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https: wss: ws:; style-src 'self' 'unsafe-inline'">
</head>
<body>
  <h1 data-vibeflow-id="page-title">Production App</h1>
  <p>This page has a strict CSP.</p>
</body>
</html>`;

describe("SaaS overlay — CSP-safe injection", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-saas-csp-"));
    // In SaaS/online mode, serve() is called without a target (API-only mode).
    // Pass _testToken and _testWorkspace to simulate authenticated SaaS state.
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
      _testToken: "mock-saas-token",
      _testWorkspace: MOCK_WORKSPACE,
    });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterAll(async () => {
    await page?.close();
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("inject page bookmarklet uses fetch+eval, not createElement('script')", async () => {
    const res = await fetch(`${BASE}/inject`);
    expect(res.ok).toBe(true);
    const html = await res.text();

    // Must use fetch+eval approach for CSP compatibility
    expect(html).toContain("fetch(");
    expect(html).toContain("eval(");

    // Must NOT inject a <script src="http://localhost:..."> which violates script-src CSP
    expect(html).not.toContain("createElement('script')");
    expect(html).not.toContain(`http://localhost:${PORT}/vibeflow-overlay.js`);
  });

  it("inject page bookmarklet references the SaaS HTTPS URL, not localhost", async () => {
    const res = await fetch(`${BASE}/inject`);
    const html = await res.text();

    // Bookmarklet must reference the SaaS origin for the fetch call
    expect(html).toContain(SAAS_BASE_URL);

    // Must NOT reference the CLI localhost port in the bookmarklet
    expect(html).not.toContain(`localhost:${PORT}`);
  });

  it("SaaS overlay script has empty wsUrl — no localhost WebSocket connection", async () => {
    const res = await fetch(`${BASE}/vibeflow-overlay.js`);
    expect(res.ok).toBe(true);
    const script = await res.text();

    // In SaaS mode, wsUrl must be empty string to prevent localhost WebSocket attempts
    expect(script).toContain('"wsUrl":""');

    // API endpoint must use the SaaS HTTPS origin, not localhost
    expect(script).toContain(`${SAAS_BASE_URL}/api/overlay/tasks`);

    // Must not reference the local CLI WebSocket
    expect(script).not.toContain(`ws://localhost:${PORT}`);
    expect(script).not.toContain(`http://localhost:${PORT}`);
  });

  it("loading the overlay on a CSP-restricted page produces no CSP violations", async () => {
    const cspViolations: string[] = [];

    // Capture console errors to detect CSP violations
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (text.includes("Content Security Policy") || text.includes("CSP") || text.includes("Refused to")) {
          cspViolations.push(text);
        }
      }
    });

    // Serve the CSP-restricted HTML via data: URL so the page itself loads.
    // Then inject the overlay via eval (simulating the bookmarklet).
    await page.setContent(CSP_RESTRICTED_HTML, { waitUntil: "domcontentloaded" });

    // Fetch the overlay script from the SaaS inject endpoint and eval it
    // This replicates what the bookmarklet does on a real production page.
    const overlayScript = await (await fetch(`${BASE}/vibeflow-overlay.js`)).text();
    await page.evaluate((script) => {
      // eslint-disable-next-line security/detect-eval-with-expression -- intentional: testing that CSP blocks eval in overlay
      try { eval(script); } catch { /* expected in test env without full SaaS backend */ }
    }, overlayScript);

    // Wait for any async CSP violations to surface (network-idle is more reliable than a fixed pause)
    await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});

    // Filter out violations caused by the overlay trying to contact the SaaS
    // backend (which isn't available in this test) — we only care about localhost violations.
    const localhostViolations = cspViolations.filter((v) =>
      v.includes(`localhost:${PORT}`) || v.includes("ws://localhost") || v.includes("http://localhost"),
    );

    if (localhostViolations.length > 0) {
      console.log("[CSP Debug] Localhost violations:", localhostViolations);
    }

    expect(localhostViolations).toHaveLength(0);
  });
});
