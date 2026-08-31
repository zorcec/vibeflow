/**
 * Playwright tests for the "What's New" changelog modal.
 *
 * Covers:
 *  - First visit baselines localStorage without showing the modal
 *  - Update (stored version older than served version) opens the modal
 *  - "View full changelog" toggle reveals older versions
 *  - Closing marks the version seen so reloads stay quiet
 *  - Header "Changelog" button opens the full changelog any time
 *
 * The kanban UI derives the running CLI version from /api/changelog when the
 * build-time define is absent (vitest runs source directly).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";
import {
  readChangelogContent,
  parseChangelogSections,
} from "../../src/core/changelog.js";

const PORT = 3931;
const BASE = `http://localhost:${PORT}`;
const LS_KEY = "vibeflow-last-seen-version";

// Newest two versions from the real CLI changelog.
const sections = parseChangelogSections(readChangelogContent() ?? "");
const TOP_VERSION = sections[0]?.version ?? "";
const SECOND_VERSION = sections[1]?.version ?? "";

let browser: Browser;
let instance: ServeInstance;
let tempDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "vf-changelog-pw-"));
  instance = await serve(undefined, {
    port: PORT,
    open: false,
    projectDir: tempDir,
  });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await instance?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function openBoard(
  seedStoredVersion: string | null,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/kanban`);
  await page.waitForSelector("#kanban-board");
  if (seedStoredVersion !== null) {
    // Wait for the first-visit baseline, then seed an older version and
    // reload. An addInitScript would re-apply on every navigation and
    // clobber later localStorage writes (e.g. the modal's mark-seen).
    await page.waitForFunction(
      (key) => localStorage.getItem(key) !== null,
      LS_KEY,
      { timeout: 5000 },
    );
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [LS_KEY, seedStoredVersion],
    );
    await page.reload();
    await page.waitForSelector("#kanban-board");
  }
  return { context, page };
}

async function storedVersion(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LS_KEY);
}

/** Text content of the modal, or "" when it is not rendered. */
async function modalText(page: Page): Promise<string> {
  return (await page.textContent("#whats-new-modal")) ?? "";
}

describe("What's New changelog modal", () => {
  it("baselines first visit without showing the modal", async () => {
    const { context, page } = await openBoard(null);
    // Give any (wrong) modal logic time to appear.
    await page.waitForTimeout(750);
    expect(await page.locator("#whats-new-modal").count()).toBe(0);
    expect(await storedVersion(page)).toBe(TOP_VERSION);
    await context.close();
  });

  it("opens the modal when the served version is newer than stored", async () => {
    const { context, page } = await openBoard("0.0.1");
    await page.waitForSelector("#whats-new-modal", { timeout: 5_000 });
    const text = await modalText(page);
    expect(text).toContain("What's new in Vibeflow");
    // Shows the section for the current (top) version only.
    expect(text).toContain(TOP_VERSION);
    if (SECOND_VERSION) {
      expect(text).not.toContain(SECOND_VERSION);
    }
    await context.close();
  });

  it("toggles to the full changelog and back", async () => {
    const { context, page } = await openBoard("0.0.1");
    await page.waitForSelector("#whats-new-modal");
    await page.click("#whats-new-toggle");
    const text = await modalText(page);
    expect(text).toContain("Changelog");
    if (SECOND_VERSION) {
      expect(text).toContain(SECOND_VERSION);
    }
    await page.click("#whats-new-toggle");
    expect(await modalText(page)).toContain("What's new in Vibeflow");
    await context.close();
  });

  it("closing marks the version seen — reload stays quiet", async () => {
    const { context, page } = await openBoard("0.0.1");
    await page.waitForSelector("#whats-new-modal");
    await page.click("#whats-new-close");
    await page.waitForSelector("#whats-new-modal", { state: "detached" });
    expect(await storedVersion(page)).toBe(TOP_VERSION);
    await page.reload();
    await page.waitForSelector("#kanban-board");
    await page.waitForTimeout(750);
    expect(await page.locator("#whats-new-modal").count()).toBe(0);
    await context.close();
  });

  it("header Changelog button opens the full changelog without an update", async () => {
    const { context, page } = await openBoard(null);
    await page.click("#changelog-btn");
    await page.waitForSelector("#whats-new-modal", { timeout: 5_000 });
    const text = await modalText(page);
    expect(text).toContain("Changelog");
    if (SECOND_VERSION) {
      expect(text).toContain(SECOND_VERSION);
    }
    await context.close();
  });
});
