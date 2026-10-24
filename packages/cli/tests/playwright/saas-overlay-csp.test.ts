/** Real browser policy enforcement; all tests run under Vitest, never the operator's browser. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveWithPort } from "../helpers/serve-with-port.js";
import { guardPage, type ErrorGuard } from "./error-guard.js";
import { chromium, type Browser, type Page } from "playwright";
import { getOverlaySaasScript, getOverlayScript } from "../../src/client/overlay/index.js";
import { buildIntegrationGuide } from "../../src/server/startup-guide.js";

const ORIGIN = "https://app.vibeflow.tools";
const SCRIPT = `${ORIGIN}/api/overlay.js`;
const BOARD = "board-csp-test-123";
const REPORTED_CSP = "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.tailwindcss.com https://unpkg.com";
const guide = buildIntegrationGuide({ url: "http://localhost:3700", localUrl: null }, {
  online: true, overlayBaseUrl: ORIGIN, boardId: BOARD,
});

function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    resolve((server.address() as { port: number }).port);
  }));
}

describe("overlay loader — Content-Security-Policy", () => {
  let browser: Browser;
  let server: Server;
  let base: string;
  const guards = new WeakMap<Page, ErrorGuard>();
  beforeAll(async () => {
    server = createServer((req, res) => {
      const policy = req.url === "/allowed" ? `${REPORTED_CSP} ${ORIGIN}`
        : req.url === "/blocked" ? "script-src 'self' 'unsafe-inline'" : REPORTED_CSP;
      res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": policy });
      res.end("<!doctype html><html><head><title>CSP fixture</title></head><body><h1>Target app</h1></body></html>");
    });
    base = `http://127.0.0.1:${await listen(server)}`;
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>(resolve => server?.close(() => resolve()));
  });

  async function fixture(path: string, script = getOverlaySaasScript(ORIGIN)): Promise<Page> {
    const page = await browser.newPage();
    guards.set(page, guardPage(page, {
      allowedConsoleErrors: {
        deliberateScriptPolicyViolation: {
          pattern: /^Loading the script '(?:https:\/\/app\.vibeflow\.tools\/api\/overlay\.js|blob:http:\/\/127\.0\.0\.1:[^']+|http:\/\/localhost:43871\/vibeflow-overlay\.js)' violates the following Content Security Policy/,
          reason: "These probes deliberately block the direct script and/or blob fallback to exercise browser CSP enforcement.",
        },
        ...(path === "/blocked" ? {
          expectedLoaderDiagnostic: {
            pattern: /^Vibeflow overlay could not initialise\. The page's Content-Security-Policy/,
            reason: "Both script paths are intentionally blocked; the test asserts this visible/console diagnostic.",
          },
        } : {}),
      },
    }));
    page.on("console", msg => console.log(`[${path}] ${msg.type()}: ${msg.text()}`));
    await page.route(SCRIPT, route => route.fulfill({
      body: script, contentType: "text/javascript", headers: { "Access-Control-Allow-Origin": base },
    }));
    await page.route(`${ORIGIN}/api/overlay/tasks**`, route => route.fulfill({
      body: JSON.stringify({ tasks: [] }), contentType: "application/json", headers: { "Access-Control-Allow-Origin": base },
    }));
    await page.goto(base + path);
    return page;
  }

  async function closePage(page: Page): Promise<void> {
    try { guards.get(page)!.assertNoErrors(); }
    finally { await page.close(); }
  }

  async function assertInitialised(page: Page, blob: boolean): Promise<void> {
    await page.waitForFunction(() => !!document.getElementById("vibeflow-studio-root")?.shadowRoot?.querySelector(".vibeflow-react-root"));
    expect(await page.evaluate("({boardId: PROTO_CONFIG.boardId, apiUrl: PROTO_CONFIG.apiUrl, wsUrl: PROTO_CONFIG.wsUrl})")).toEqual({
      boardId: BOARD, apiUrl: `${ORIGIN}/api/overlay/tasks`, wsUrl: "",
    });
    expect(await page.locator('script[data-vibeflow-overlay]').getAttribute("src")).toMatch(blob ? /^blob:/ : /^https:/);
    expect(await page.locator("#vibeflow-overlay-load-error").count()).toBe(0);
    console.log(`[initialised] board=${BOARD} api=${ORIGIN}/api/overlay/tasks blob=${blob}`);
  }

  it("reproduces the old external-script blank overlay under the exact reported header", async () => {
    const page = await fixture("/reported-old");
    try {
      const errors: string[] = [];
      page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
      await page.evaluate(url => new Promise(resolve => {
        const script = document.createElement("script");
        script.src = url;
        script.onerror = () => resolve("blocked");
        document.head.appendChild(script);
      }), SCRIPT);
      expect(errors.some(text => text.includes("Content Security Policy") && text.includes(SCRIPT))).toBe(true);
      expect(await page.locator("#vibeflow-studio-root").count()).toBe(0);
    } finally { await closePage(page); }
  });

  it("initialises the real overlay through the allowed external-script path", async () => {
    const page = await fixture("/allowed");
    try {
      await page.evaluate(guide.consoleSnippet);
      await assertInitialised(page, false);
    } finally { await closePage(page); }
  });

  it("initialises the real overlay with board and origin via blob fallback under the exact reported header", async () => {
    const page = await fixture("/reported-new");
    try {
      // Execute the issued bookmarklet rather than just a hand-written loader.
      await page.evaluate(guide.bookmarkletCode.slice("javascript:".length));
      await assertInitialised(page, true);
    } finally { await closePage(page); }
  });

  it("shows a visible CSP remedy and console error when external and blob scripts are both blocked", async () => {
    const page = await fixture("/blocked");
    try {
      const errors: string[] = [];
      page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
      await page.evaluate(guide.consoleSnippet);
      await page.waitForSelector("#vibeflow-overlay-load-error");
      const message = await page.locator('[role="alert"]').textContent();
      expect(message).toContain("Content-Security-Policy (CSP)");
      expect(message).toContain("browser extension");
      expect(errors).toContain(message);
      expect(await page.locator("#vibeflow-studio-root").count()).toBe(0);
    } finally { await closePage(page); }
  });

  it("the served /inject bookmarklet survives HTML attribute encoding and runs", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "vf-csp-guide-"));
    const instance = await serveWithPort(undefined, {
      projectDir, open: false, _testToken: "fixture-token",
      _testWorkspace: { id: BOARD, name: "CSP fixture", url: `${ORIGIN}/kanban?board=${BOARD}` },
    });
    const page = await fixture("/served-bookmarklet");
    try {
      const html = await (await fetch(instance.url + "/inject")).text();
      expect(html).not.toContain("CSP-safe");
      expect(html).toContain("strict-dynamic");
      const bookmarklet = await page.evaluate(source => {
        const parsed = new DOMParser().parseFromString(source, "text/html");
        return parsed.querySelector("a.bookmarklet")?.getAttribute("href");
      }, html);
      expect(bookmarklet).toBe(guide.bookmarkletCode);
      await page.evaluate(bookmarklet!.slice("javascript:".length));
      await assertInitialised(page, true);
    } finally {
      try { await closePage(page); }
      finally {
        await instance.close();
        rmSync(projectDir, { recursive: true, force: true });
      }
    }
  });

  it("preserves the local API/WS origin through the blob fallback", async () => {
    const localOrigin = "http://localhost:43871";
    const localScript = `${localOrigin}/vibeflow-overlay.js`;
    const localGuide = buildIntegrationGuide({ url: localOrigin, localUrl: null }, { boardId: BOARD });
    const page = await fixture("/local-blob");
    try {
      await page.route(localScript, route => route.fulfill({
        body: getOverlayScript(43871), contentType: "text/javascript", headers: { "Access-Control-Allow-Origin": base },
      }));
      await page.route(`${localOrigin}/api/**`, route => route.fulfill({
        body: JSON.stringify({ tasks: [], pages: [] }), contentType: "application/json", headers: { "Access-Control-Allow-Origin": base },
      }));
      await page.routeWebSocket("ws://localhost:43871/**", ws => { ws.onMessage(() => {}); });
      await page.evaluate(localGuide.consoleSnippet);
      await page.waitForSelector("#vibeflow-studio-root");
      expect(await page.evaluate("({boardId: PROTO_CONFIG.boardId, apiUrl: PROTO_CONFIG.apiUrl, wsUrl: PROTO_CONFIG.wsUrl})")).toEqual({
        boardId: BOARD, apiUrl: `${localOrigin}/api/tasks`, wsUrl: "ws://localhost:43871",
      });
      expect(await page.locator('script[data-vibeflow-overlay]').getAttribute("src")).toMatch(/^blob:/);
    } finally { await closePage(page); }
  });
});
