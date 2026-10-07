/**
 * Playwright e2e: paste-to-attach in the overlay task form (floating popover).
 *
 * The popover is the user-reachable task-creation surface of the injected
 * overlay (vibeflow-overlay.js): Alt+A → click an element → title +
 * description + Save → POST /api/tasks. This spec proves screenshots can be
 * pasted into that form:
 *  1. Ctrl/⌘V with an image in the clipboard buffers a quiet thumbnail chip
 *     (32px preview + filename + ×), visible in the form;
 *  2. × removes the buffered file without submitting;
 *  3. saving uploads the buffered file so it lands on the task
 *     (GET /api/tasks/:id/files — the same endpoint the kanban Files pane
 *     reads), as real JPEG bytes;
 *  4. non-image files (csv) paste as 📎 chips and upload with their name kept.
 *
 * Paste is simulated exactly like the kanban suite does: a real ClipboardEvent
 * carrying a DataTransfer with a File, dispatched on the shadow-DOM textarea.
 * Hermetic scratch server on a free high port; no sleeps — explicit waits only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const SHOT_DIR = "/tmp/overlay-paste";

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Paste fixture</title>
  <style>
    body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; }
  </style>
</head>
<body>
  <main data-vibeflow-id="paste-main">
    <h1 data-vibeflow-id="paste-title">Paste target</h1>
    <button data-vibeflow-id="paste-cta">Paste Action</button>
  </main>
</body>
</html>`;

const PNG_BYTES = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
  120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 160, 90, 186, 57, 0, 0, 0, 0,
  73, 69, 78, 68, 174, 66, 96, 130,
];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port =
        typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

describe("Overlay popover — paste screenshot to attach", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;
  let port: number;
  let base: string;

  beforeAll(async () => {
    mkdirSync(SHOT_DIR, { recursive: true });
    port = await freePort();
    base = `http://localhost:${port}`;
    tempDir = mkdtempSync(join(tmpdir(), "proto-overlaypaste-pw-"));
    writeFileSync(join(tempDir, "index.html"), FIXTURE_HTML, "utf-8");

    instance = await serve(join(tempDir, "index.html"), {
      port,
      open: false,
    });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    page = await context.newPage();
    await page.goto(base);
    await page.waitForFunction(
      () =>
        !!(document.querySelector("#vibeflow-studio-root") as HTMLElement)
          ?.shadowRoot,
      { timeout: 10_000 },
    );
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function isAnnotating(): Promise<boolean> {
    return page.evaluate(() =>
      document.body.classList.contains("vibeflow-overlay-active"),
    );
  }

  async function openPopover(targetId: string): Promise<void> {
    // Alt+A toggles: only press when annotation mode is off (saving a task
    // leaves it on, dismissing with Escape turns it off).
    if (!(await isAnnotating())) await page.keyboard.press("Alt+a");
    await page.click(`[data-vibeflow-id="${targetId}"]`);
    await page.waitForFunction(() => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement;
      return !!host?.shadowRoot?.querySelector(".vibeflow-popover");
    }, { timeout: 5_000 });
  }

  async function closePopover(): Promise<void> {
    if (await isAnnotating()) await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement;
      return !host?.shadowRoot?.querySelector(".vibeflow-popover");
    }, { timeout: 5_000 });
    // Leave annotation mode off as well so each test starts clean.
    if (await isAnnotating()) await page.keyboard.press("Escape");
  }

  /** Dispatch a real ClipboardEvent paste on the popover textarea. */
  async function pasteIntoPopover(
    kind: "image" | "csv" | "text",
  ): Promise<void> {
    await page.evaluate(
      ({ bytes, pasteKind }) => {
        const host = document.querySelector(
          "#vibeflow-studio-root",
        ) as HTMLElement;
        const sr = host?.shadowRoot;
        const textarea = sr?.querySelector(
          ".vibeflow-popover textarea",
        ) as HTMLElement;
        if (!textarea) throw new Error("popover textarea not found");
        const dt = new DataTransfer();
        if (pasteKind === "image") {
          const file = new File([new Uint8Array(bytes)], "clipboard.png", {
            type: "image/png",
          });
          dt.items.add(file);
        } else if (pasteKind === "csv") {
          const file = new File(["a,b\n1,2\n"], "data.csv", {
            type: "text/csv",
          });
          dt.items.add(file);
        } else {
          dt.setData("text/plain", "just some words");
        }
        const event = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        textarea.dispatchEvent(event);
      },
      { bytes: PNG_BYTES, pasteKind: kind },
    );
  }

  async function chipCount(): Promise<number> {
    return page.evaluate(() => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement;
      return (
        host?.shadowRoot?.querySelectorAll(".vibeflow-paste-chip").length ?? 0
      );
    });
  }

  async function waitForChips(n: number): Promise<void> {
    await page.waitForFunction(
      (expected) => {
        const host = document.querySelector(
          "#vibeflow-studio-root",
        ) as HTMLElement;
        return (
          (host?.shadowRoot?.querySelectorAll(".vibeflow-paste-chip").length ??
            0) >= expected
        );
      },
      n,
      { timeout: 10_000 },
    );
  }

  async function taskIdByTitle(title: string): Promise<string> {
    const tasks = (await fetch(`${base}/api/tasks`).then((r) =>
      r.json(),
    )) as { tasks: Array<{ id: string; title: string }> };
    const task = tasks.tasks.find((t) => t.title === title);
    expect(task).toBeDefined();
    return task?.id as string;
  }

  async function waitForFile(
    taskId: string,
    match: RegExp,
    count = 1,
  ): Promise<Array<{ name: string }>> {
    await page.waitForFunction(
      async ({ api, id, source, want, need }) => {
        const res = await fetch(`${api}/${id}/files`);
        const data = (await res.json()) as { files?: Array<{ name: string }> };
        const re = new RegExp(source, want);
        return (
          (data.files || []).filter((f) => re.test(f.name)).length >= need
        );
      },
      {
        api: `${base}/api/tasks`,
        id: taskId,
        source: match.source,
        want: match.flags,
        need: count,
      },
      { timeout: 15_000 },
    );
    const res = await fetch(`${base}/api/tasks/${taskId}/files`);
    const data = (await res.json()) as { files: Array<{ name: string }> };
    return data.files.filter((f) => match.test(f.name));
  }

  it("pasting an image shows a thumbnail chip with the screenshot name", async () => {
    await openPopover("paste-cta");
    await pasteIntoPopover("image");
    await waitForChips(1);

    const name = await page.evaluate(() => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement;
      return (
        host?.shadowRoot?.querySelector(".vibeflow-paste-name")
          ?.textContent ?? ""
      );
    });
    // Real Chromium compresses to JPEG (kanban parity); the chip shows it.
    expect(name).toMatch(/^paste-.*\.jpg$/);

    const thumb = await page.evaluate(() => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement;
      const img = host?.shadowRoot?.querySelector(
        ".vibeflow-paste-chip img",
      ) as HTMLImageElement | null;
      return {
        src: img?.getAttribute("src") ?? "",
        w: img?.getBoundingClientRect().width ?? 0,
      };
    });
    expect(thumb.src.startsWith("blob:")).toBe(true);
    expect(thumb.w).toBeGreaterThan(0);

    // Fresh screenshot of the pasted chip for the review record.
    await page.screenshot({ path: join(SHOT_DIR, "iter1-popover-chip.png") });
    await closePopover();
  });

  it("plain-text paste is not intercepted (no chip for words)", async () => {
    await openPopover("paste-title");
    // Text first, then an image: waiting for exactly one chip proves the text
    // paste added nothing while the image paste still landed.
    await pasteIntoPopover("text");
    await pasteIntoPopover("image");
    await waitForChips(1);
    expect(await chipCount()).toBe(1);
    const name = await page.evaluate(() => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement;
      return (
        host?.shadowRoot?.querySelector(".vibeflow-paste-name")
          ?.textContent ?? ""
      );
    });
    expect(name).toMatch(/^paste-.*\.jpg$/);
    await closePopover();
  });

  it("× removes the buffered screenshot without submitting", async () => {
    await openPopover("paste-cta");
    await pasteIntoPopover("image");
    await waitForChips(1);

    await page.evaluate(() => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement;
      (
        host?.shadowRoot?.querySelector(
          ".vibeflow-paste-remove",
        ) as HTMLElement
      )?.click();
    });
    await page.waitForFunction(() => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement;
      return (
        (host?.shadowRoot?.querySelectorAll(".vibeflow-paste-chip").length ??
          0) === 0
      );
    }, { timeout: 5_000 });
    expect(await chipCount()).toBe(0);
    await closePopover();

    const tasks = (await fetch(`${base}/api/tasks`).then((r) =>
      r.json(),
    )) as { tasks: unknown[] };
    expect(tasks.tasks).toHaveLength(0);
  });

  it("saving uploads the pasted screenshot onto the created task", async () => {
    await openPopover("paste-cta");
    await pasteIntoPopover("image");
    await waitForChips(1);

    await page.evaluate(() => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement;
      const input = host?.shadowRoot?.querySelector(
        ".vibeflow-popover input[type='text']",
      ) as HTMLInputElement;
      if (input) input.value = "Overlay paste screenshot task";
      const btn = host?.shadowRoot?.querySelector(
        ".vibeflow-popover .btn-primary",
      ) as HTMLElement;
      btn?.click();
    });

    const taskId = await taskIdByTitle("Overlay paste screenshot task");
    const files = await waitForFile(taskId, /^paste-.*\.jpg$/);
    expect(files).toHaveLength(1);

    // The stored bytes are a real JPEG (compression ran in Chromium).
    const bytes = new Uint8Array(
      await fetch(
        `${base}/api/tasks/${taskId}/files/${encodeURIComponent(files[0].name)}`,
      ).then((r) => r.arrayBuffer()),
    );
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it("pasting a csv attaches it with its name kept", async () => {
    await openPopover("paste-title");
    await pasteIntoPopover("csv");
    await waitForChips(1);

    const chipText = await page.evaluate(() => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement;
      const chip = host?.shadowRoot?.querySelector(".vibeflow-paste-chip");
      return {
        name:
          chip?.querySelector(".vibeflow-paste-name")?.textContent ?? "",
        hasImg: !!chip?.querySelector("img"),
        icon: chip?.querySelector(".vibeflow-paste-fileicon")?.textContent ?? "",
      };
    });
    expect(chipText.name).toBe("data.csv");
    expect(chipText.hasImg).toBe(false);
    expect(chipText.icon).not.toBe("");

    await page.evaluate(() => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement;
      const input = host?.shadowRoot?.querySelector(
        ".vibeflow-popover input[type='text']",
      ) as HTMLInputElement;
      if (input) input.value = "Overlay paste csv task";
      const btn = host?.shadowRoot?.querySelector(
        ".vibeflow-popover .btn-primary",
      ) as HTMLElement;
      btn?.click();
    });

    const taskId = await taskIdByTitle("Overlay paste csv task");
    const files = await waitForFile(taskId, /^data\.csv$/);
    expect(files).toHaveLength(1);
  });
});
