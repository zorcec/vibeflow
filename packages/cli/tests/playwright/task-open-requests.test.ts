/**
 * Ticket d4c533f9 — opening ONE task must issue exactly ONE
 * `GET /api/tasks/:id/files` and exactly ONE `GET /api/tasks/:id/comments`.
 *
 * Before the fix, one open produced a burst (the owner counted 4 rounds of
 * comments+files, all 304): every WS frame bumped BOTH version counters, and
 * the panel mount itself fetched the files list twice. This spec counts the
 * requests on the wire while opening a single task and asserts the count —
 * plus the shared console-error/failed-request guard.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";
import { getFreePort } from "../ports.js";
import { guardContext, type ErrorGuard } from "./error-guard";
import { openTaskByTitle, waitForTaskOnBoard } from "./kanban-helpers";

let PORT = 0;
let BASE = "";
let API = "";

const TASK_TITLE = "Request-count probe task";

describe("Task open request counts (d4c533f9)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;
  let guard: ErrorGuard;
  let taskId: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-task-open-reqs-"));

    const opened: ServeInstance[] = [];
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        PORT = await getFreePort();
        const booted = await serve(undefined, {
          port: PORT,
          open: false,
          projectDir: tempDir,
        });
        opened.push(booted);
        instance = booted;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!instance) {
      await Promise.all(opened.map((i) => i.close()));
      throw lastErr;
    }
    BASE = `http://localhost:${PORT}`;
    API = `${BASE}/api/tasks`;

    // One task with one comment and one file, so the panel has data to load
    // but nothing that legitimately needs a second round.
    const createRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: TASK_TITLE,
        description: "count the files/comments fetches for this open",
        selector: "/",
        status: "todo",
      }),
    });
    const created = (await createRes.json()) as {
      success: boolean;
      task?: { id: string };
    };
    expect(created.success).toBe(true);
    taskId = created.task!.id;
    await fetch(`${API}/${taskId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "user", text: "seed comment" }),
    });
    await fetch(`${API}/${taskId}/files/seed.txt`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "seed file",
    });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
    });
    page = await context.newPage();
    guard = guardContext(context);

    await page.goto(`${BASE}/kanban`);
    await page.waitForSelector("#kanban-board");
    await waitForTaskOnBoard(page, taskId);
  });

  afterEach(() => guard.assertNoErrors());

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("opening one task fetches files and comments exactly once each", async () => {
    const filesReqs: string[] = [];
    const commentsReqs: string[] = [];
    const onRequest = (req: { method(): string; url(): string }) => {
      const url = req.url();
      if (req.method() !== "GET") return;
      // Anchored: file CONTENT downloads live under /files/<name> and must
      // not count as list fetches.
      if (/\/api\/tasks\/[^/]+\/files$/.test(url)) filesReqs.push(url);
      if (/\/api\/tasks\/[^/]+\/comments$/.test(url)) commentsReqs.push(url);
    };
    page.on("request", onRequest);
    try {
      // The board is settled (card visible, WS connected); reset so the
      // window below covers the open and nothing else.
      filesReqs.length = 0;
      commentsReqs.length = 0;

      await openTaskByTitle(page, TASK_TITLE);

      // The panel's data round is one comments + one files fetch. Late
      // WS-driven refetch rounds (the pre-fix burst) arrive within ~1s of
      // the open's broadcasts — networkidle plus a grace window catches
      // them instead of asserting too early.
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(2_500);

      expect(commentsReqs).toHaveLength(1);
      expect(filesReqs).toHaveLength(1);
    } finally {
      page.off("request", onRequest);
    }
  });
});
