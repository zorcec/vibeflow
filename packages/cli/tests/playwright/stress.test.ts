/**
 * Stress tests for Kanban UI rendering and WebSocket scalability.
 *
 * Measures:
 *  - Browser memory usage when rendering large task lists
 *  - Server memory usage under load
 *  - WebSocket broadcast latency with many concurrent clients
 *  - UI render time for large datasets
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3903;
const BASE = `http://localhost:${PORT}`;
const API = `http://localhost:${PORT}/api/tasks`;
const WS_URL = `ws://localhost:${PORT}`;

const STRESS_TASK_COUNT = 500;

describe("Stress: Kanban UI and WebSocket scalability", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-stress-pw-"));
    instance = await serve(undefined, { port: PORT, open: false, projectDir: tempDir });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await page.goto(`${BASE}/kanban`);
    await page.waitForSelector("#kanban-board");
  }, 30_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(`renders ${STRESS_TASK_COUNT} tasks: measure UI render time and browser memory`, async () => {
    const statuses = ["todo", "in-progress", "review", "backlog", "done"];
    const taskIds: string[] = [];

    // Create tasks in parallel batches of 50
    for (let batch = 0; batch < STRESS_TASK_COUNT / 50; batch++) {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: `Stress task ${batch * 50 + i} — performance test`,
              status: statuses[(batch * 50 + i) % statuses.length],
              selector: `/page-${(batch * 50 + i) % 10}`,
            }),
          }).then((r) => r.json() as Promise<{ task?: { id: string } }>),
        ),
      );
      for (const data of results) {
        if (data.task?.id) taskIds.push(data.task.id);
      }
    }
    expect(taskIds.length).toBe(STRESS_TASK_COUNT);

    const memBefore = await page.evaluate(() => {
      return (performance as any).memory?.usedJSHeapSize ?? 0;
    });

    const renderStart = Date.now();
    await page.reload();
    await page.waitForSelector("#kanban-board");
    await page.waitForFunction(
      () => document.querySelectorAll("[data-task-id]").length > 0,
      { timeout: 15_000 },
    );
    const renderMs = Date.now() - renderStart;

    const memAfter = await page.evaluate(() => {
      return (performance as any).memory?.usedJSHeapSize ?? 0;
    });
    const browserHeapMB = (memAfter - memBefore) / 1024 / 1024;

    const serverMem = process.memoryUsage();
    const serverRssMB = serverMem.rss / 1024 / 1024;
    const serverHeapMB = serverMem.heapUsed / 1024 / 1024;

    console.log(`[stress-ui] ${STRESS_TASK_COUNT} tasks rendered in ${renderMs}ms`);
    console.log(`[stress-ui] Browser heap delta: ${browserHeapMB.toFixed(1)}MB`);
    console.log(`[stress-ui] Server RSS: ${serverRssMB.toFixed(1)}MB | Heap: ${serverHeapMB.toFixed(1)}MB`);
    console.log(`[stress-ui] Estimated production: ~${Math.ceil(serverRssMB / STRESS_TASK_COUNT * 10000)}MB RAM for 10k tasks`);

    // Done column should respect the 20-task limit
    const doneCount = await page.locator('[data-column-id="done"] [data-task-id]').count();
    expect(doneCount).toBeLessThanOrEqual(20);

    expect(renderMs).toBeLessThan(15_000);

    // Clean up
    await Promise.all(taskIds.map((id) =>
      fetch(`${API}/${id}`, { method: "DELETE" }),
    ));
  }, 120_000);

  it("WebSocket: 50 concurrent clients all receive broadcast within 2s", async () => {
    const CLIENT_COUNT = 50;
    const clients: WebSocket[] = [];
    const received: number[] = [];

    // Connect all clients
    await Promise.all(
      Array.from({ length: CLIENT_COUNT }, (_, i) =>
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(WS_URL);
          ws.on("open", () => {
            clients.push(ws);
            resolve();
          });
          ws.on("error", reject);
          setTimeout(reject, 5000);
        }),
      ),
    );
    expect(clients.length).toBe(CLIENT_COUNT);

    // Set up message listeners
    const allReceived = new Promise<void>((resolve) => {
      for (const [idx, ws] of clients.entries()) {
        ws.on("message", (data: Buffer) => {
          const msg = JSON.parse(data.toString()) as { type?: string };
          if (msg.type === "tasks-updated") {
            received.push(idx);
            if (received.length === CLIENT_COUNT) resolve();
          }
        });
      }
    });

    // Trigger a broadcast by creating a task (server broadcasts tasks-updated)
    const broadcastStart = Date.now();
    await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "WS stress task", selector: "/", status: "todo" }),
    });

    await Promise.race([
      allReceived,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Broadcast timeout")), 2000)),
    ]);

    const broadcastMs = Date.now() - broadcastStart;
    console.log(`[stress-ws] ${CLIENT_COUNT} clients received broadcast in ${broadcastMs}ms`);
    expect(received.length).toBe(CLIENT_COUNT);
    expect(broadcastMs).toBeLessThan(2000);

    // Close all clients
    for (const ws of clients) ws.close();
  }, 30_000);

  it("WebSocket: server handles 100 concurrent connections without crash", async () => {
    const CLIENT_COUNT = 100;
    const clients: WebSocket[] = [];

    await Promise.all(
      Array.from({ length: CLIENT_COUNT }, () =>
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(WS_URL);
          ws.on("open", () => { clients.push(ws); resolve(); });
          ws.on("error", reject);
          setTimeout(reject, 5000);
        }),
      ),
    );

    const serverMem = process.memoryUsage();
    console.log(`[stress-ws] 100 clients connected | Server RSS: ${(serverMem.rss / 1024 / 1024).toFixed(1)}MB`);
    expect(clients.length).toBe(CLIENT_COUNT);

    // Cleanup
    for (const ws of clients) ws.close();
  }, 30_000);
});
