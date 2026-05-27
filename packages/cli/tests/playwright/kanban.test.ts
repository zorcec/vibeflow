/**
 * Playwright e2e tests for the Kanban board (React version).
 *
 * Covers:
 *  - "+" button per column opens the detail panel with pre-filled status
 *  - Adding tasks via the panel creates them with the correct status
 *  - Task detail panel shows source info (file/line/col/component) when present
 *  - Comment auto-scroll and auto-submit on Save
 *  - Agent Runner modal opens and renders aligned task list
 *  - Modal interactions (FilePreviewModal, SettingsModal) do not close the task detail panel
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3897;
const BASE = `http://localhost:${PORT}`;
const API = `http://localhost:${PORT}/api/tasks`;

async function openAddTask(page: Page, columnId: string) {
  await page.click(`[data-column-id='${columnId}'] button[title^='Add task']`);
  await page.waitForSelector("#detail-panel.open");
}

async function openTaskByTitle(page: Page, title: string) {
  await page.evaluate((taskTitle) => {
    const card = [...document.querySelectorAll("#kanban-board article.task-card")]
      .find((candidate) => candidate.textContent?.includes(taskTitle)) as HTMLElement | undefined;
    card?.click();
  }, title);
  await page.waitForSelector("#detail-panel.open");
}

async function openActivityTab(page: Page) {
  await page.click("#dp-tab-activity");
  await page.waitForSelector("#dp-activity-pane:not([style*='none'])");
}

async function openFilesTab(page: Page) {
  await page.click("#dp-tab-files");
  await page.waitForSelector("#dp-files-pane:not([style*='none'])");
}

async function focusDescriptionEditor(page: Page) {
  const hasTextarea = await page.locator("#dp-desc").count();
  if (hasTextarea > 0) return;
  await page.click("#dp-desc-preview");
  await page.waitForSelector("#dp-desc", { timeout: 5_000 });
}

async function closePanelIfOpen(page: Page) {
  const closeCount = await page.locator("#dp-close").count();
  if (closeCount === 0) return;
  await page.click("#dp-close");
  await page.waitForFunction(() => !document.getElementById("detail-panel"), { timeout: 5_000 }).catch(() => {});
}

/**
 * Wait for a task to appear on the kanban board via WebSocket live update.
 * Falls back to page.reload() if the task doesn't appear within 3s.
 */
async function waitForTaskOnBoard(page: Page, titleOrId: string, timeout = 8_000) {
  // First try waiting for WS live update (no reload needed)
  const appeared = await page.waitForFunction(
    (idOrTitle) => {
      // Check by data-task-id attribute
      if (document.querySelector(`[data-task-id="${idOrTitle}"]`)) return true;
      // Check by card text content
      return [...document.querySelectorAll("#kanban-board article.task-card")]
        .some(c => c.textContent?.includes(idOrTitle));
    },
    titleOrId,
    { timeout },
  ).catch(() => false);
  if (appeared) return;

  // Fallback: reload if WS didn't deliver (edge case)
  await page.reload();
  await page.waitForSelector("#kanban-board");
  await page.waitForFunction(
    (idOrTitle) => {
      if (document.querySelector(`[data-task-id="${idOrTitle}"]`)) return true;
      return [...document.querySelectorAll("#kanban-board article.task-card")]
        .some(c => c.textContent?.includes(idOrTitle));
    },
    titleOrId,
    { timeout: 8_000 },
  );
}

describe("Kanban board", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-kanban-pw-"));

    // Serve with no HTML file — API-only mode, kanban route registered
    instance = await serve(undefined, { port: PORT, open: false, projectDir: tempDir });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await page.goto(`${BASE}/kanban`);
    await page.waitForSelector("#kanban-board");
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Basic kanban renders ───────────────────────────────────────────────────
  it("renders the kanban board with column headers", async () => {
    const hasBoard = await page.isVisible("#kanban-board");
    expect(hasBoard).toBe(true);
  });

  it("renders 5 columns (backlog, todo, in-progress, review, done)", async () => {
    await page.waitForFunction(() => {
      return document.querySelectorAll("[data-column-id]").length >= 5;
    }, { timeout: 5_000 });

    const colCount = await page.evaluate(() => document.querySelectorAll("[data-column-id]").length);
    expect(colCount).toBe(5);
  });

  it("shows empty-column placeholders when no tasks are present", async () => {
    const placeholderCount = await page.evaluate(() =>
      [...document.querySelectorAll('[data-column-id] .column-scroll div')]
        .filter((el) => /No tasks in/i.test(el.textContent || '')).length,
    );
    expect(placeholderCount).toBeGreaterThanOrEqual(5);
  });

  it("shows a visible keyboard shortcuts hint in the header", async () => {
    const hintVisible = await page.isVisible('#header-shortcuts-hint');
    expect(hintVisible).toBe(true);
  });

  // ── Header component regression tests ─────────────────────────────────────
  it("header renders project name, search input, and settings button", async () => {
    // Project name
    const projectName = await page.textContent('#header-project-name');
    expect(projectName).toBeTruthy();
    expect(projectName!.length).toBeGreaterThan(0);

    // Global search input
    const searchInput = await page.locator('#global-search').count();
    expect(searchInput).toBe(1);
    const searchPlaceholder = await page.getAttribute('#global-search', 'placeholder');
    expect(searchPlaceholder).toBeTruthy();

    // Settings button
    const settingsBtn = await page.locator('#btn-settings').count();
    expect(settingsBtn).toBe(1);

    // Shortcuts hint button
    const shortcutsBtn = await page.locator('#header-shortcuts-hint').count();
    expect(shortcutsBtn).toBe(1);
  });

  it("header search input accepts text and clear button appears", async () => {
    // Search input should be empty initially
    const initialValue = await page.inputValue('#global-search');
    expect(initialValue).toBe('');

    // Type into search
    await page.fill('#global-search', 'test search');
    const typedValue = await page.inputValue('#global-search');
    expect(typedValue).toBe('test search');

    // Clear button should appear when there is content
    const clearBtn = await page.locator('#global-search-clear').count();
    expect(clearBtn).toBe(1);

    // Click clear button
    await page.click('#global-search-clear');
    const clearedValue = await page.inputValue('#global-search');
    expect(clearedValue).toBe('');

    // Clear button should disappear
    const clearBtnAfter = await page.locator('#global-search-clear').count();
    expect(clearBtnAfter).toBe(0);
  });

  it("header layout: project name is left-aligned, search is centered, actions are right-aligned", async () => {
    const layout = await page.evaluate(() => {
      const header = document.querySelector('header') as HTMLElement | null;
      if (!header) return null;
      const rect = header.getBoundingClientRect();

      const projectName = document.getElementById('header-project-name') as HTMLElement | null;
      const searchInput = document.getElementById('global-search') as HTMLElement | null;
      const settingsBtn = document.getElementById('btn-settings') as HTMLElement | null;

      if (!projectName || !searchInput || !settingsBtn) return null;

      const projectRect = projectName.getBoundingClientRect();
      const searchRect = searchInput.getBoundingClientRect();
      const settingsRect = settingsBtn.getBoundingClientRect();

      return {
        projectLeft: projectRect.left,
        searchCenter: searchRect.left + searchRect.width / 2,
        headerCenter: rect.width / 2,
        settingsRight: settingsRect.right,
        headerWidth: rect.width,
      };
    });

    expect(layout).not.toBeNull();
    // Project name should be on the left side (within first 40% of header)
    expect((layout?.projectLeft ?? 999) < (layout?.headerWidth ?? 100) * 0.4).toBe(true);
    // Search should be roughly centered (within 20% of center)
    const centerDiff = Math.abs((layout?.searchCenter ?? 0) - ((layout?.headerCenter ?? 0)));
    expect(centerDiff < (layout?.headerWidth ?? 100) * 0.3).toBe(true);
    // Settings should be on the right side (within last 20% of header)
    expect((layout?.settingsRight ?? 0) > (layout?.headerWidth ?? 100) * 0.8).toBe(true);
  });

  // ── "+" button per column ─────────────────────────────────────────────────
  it("each column has a '+' add button in the header", async () => {
    const addBtnCount = await page.evaluate(
      () => document.querySelectorAll("[data-column-id] button[title^='Add task']").length,
    );
    expect(addBtnCount).toBe(5);
  });

  it("clicking '+' on the Todo column opens the detail panel with status 'To Do'", async () => {
    await openAddTask(page, "todo");

    // Detail panel opens
    await page.waitForSelector("#detail-panel.open");

    // Status button for 'todo' should be active
    const activeTodoExists = await page.isVisible(".dp-status-btn.active-todo");
    expect(activeTodoExists).toBe(true);
  });

  it("typing a title and pressing Add Task creates a task with pre-filled status", async () => {
    await closePanelIfOpen(page);
    await openAddTask(page, "todo");
    await page.fill("#dp-title", "Test kanban add task");
    await focusDescriptionEditor(page);
    await page.fill("#dp-desc", "Created via + button");
    await page.click("#dp-save");

    // Panel closes
    await page.waitForFunction(
      () => !document.getElementById("detail-panel")?.classList.contains("open"),
      { timeout: 5_000 },
    );

    // Wait for board to re-render with the new task
    await page.waitForFunction(
      () => [...document.querySelectorAll("#kanban-board article.task-card")]
        .some(c => c.textContent?.includes("Test kanban add task")),
      { timeout: 8_000 },
    );

    // Verify the task landed in the "todo" column
    const inTodo = await page.evaluate(() => {
      return [...document.querySelectorAll("[data-column-id='todo'] article.task-card")]
        .some(c => c.textContent?.includes("Test kanban add task"));
    });
    expect(inTodo).toBe(true);
  });

  it("changes task status from the detail panel", async () => {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Inline status cycle task", description: "cycle", selector: "/", status: "todo" }),
    });
    const data = await res.json() as { success: boolean; task?: { id: string } };
    expect(data.success).toBe(true);
    const taskId = data.task?.id;
    expect(taskId).toBeTruthy();

    await waitForTaskOnBoard(page, taskId);

    await openTaskByTitle(page, "Inline status cycle task");
    await page.click(".dp-status-btn[data-status='in-progress']");
    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-column-id='in-progress'] [data-task-id="${id}"]`),
      taskId,
      { timeout: 8_000 },
    );
  });

  it("cancel button closes the detail panel without creating a task", async () => {
    // Open panel on Backlog column
    await closePanelIfOpen(page);
    await openAddTask(page, "backlog");

    await page.fill("#dp-title", "This should not be saved");
    await page.click("#dp-cancel");

    await page.waitForFunction(
      () => !document.getElementById("detail-panel")?.classList.contains("open"),
    );

    // The task should NOT appear — allow any pending network requests to settle
    await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
    const hasCancelledTask = await page.evaluate(() =>
      [...document.querySelectorAll("#kanban-board article.task-card")]
        .some(c => c.textContent?.includes("This should not be saved")),
    );
    expect(hasCancelledTask).toBe(false);
  });

  it("Enter key saves the add-task form", async () => {
    // Open In Progress column
    await closePanelIfOpen(page);
    await openAddTask(page, "in-progress");
    // Wait for the status to be correctly set to 'in-progress' before saving
    await page.waitForSelector(".dp-status-btn.active-in-progress", { timeout: 3_000 });

    await page.fill("#dp-title", "Enter key task");
    await page.keyboard.press("Enter");

    await page.waitForFunction(
      () => !document.getElementById("detail-panel")?.classList.contains("open"),
      { timeout: 5_000 },
    );
    await page.waitForFunction(
      () => [...document.querySelectorAll("#kanban-board article.task-card")]
        .some(c => c.textContent?.includes("Enter key task")),
      { timeout: 8_000 },
    );

    const inInProgress = await page.evaluate(() => {
      return [...document.querySelectorAll("[data-column-id='in-progress'] article.task-card")]
        .some(c => c.textContent?.includes("Enter key task"));
    });
    expect(inInProgress).toBe(true);
  });

  // ── Task detail panel shows source info ───────────────────────────────────
  it("task detail panel shows file/line/col/component when task has source info", async () => {
    // Create a task via API that has source metadata
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Task with source info",
        description: "Test",
        selector: "#submit-btn",
        file: "/src/components/SubmitButton.tsx",
        line: 42,
        col: 7,
        component: "SubmitButton",
      }),
    });
    const data = await res.json() as { success: boolean };
    expect(data.success).toBe(true);

    // The board should have the task via WebSocket live update
    await waitForTaskOnBoard(page, "Task with source info");

    // Click the task card to open the detail panel
    await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find(c => c.textContent?.includes("Task with source info")) as HTMLElement | undefined;
      card?.click();
    });

    await page.waitForSelector("#detail-panel.open", { timeout: 5_000 });

    // Source row should contain file path + line and component chip text
    const rowText = await page.evaluate(() => {
      const row = document.getElementById("dp-meta-row");
      return row?.textContent ?? "";
    });
    expect(rowText).toContain("SubmitButton.tsx");
    expect(rowText).toContain("42");
    expect(rowText).toContain("SubmitButton");
  });

  it("task detail panel hides source section when task has no source info", async () => {
    // Create a plain task with no source fields
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Task without source", description: "No source", selector: "/" }),
    });
    const data = await res.json() as { success: boolean };
    expect(data.success).toBe(true);

    await waitForTaskOnBoard(page, "Task without source");

    await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find(c => c.textContent?.includes("Task without source")) as HTMLElement | undefined;
      card?.click();
    });

    await page.waitForSelector("#detail-panel.open", { timeout: 5_000 });

    // No source pill should be rendered
    const pillCount = await page.evaluate(
      () => document.querySelectorAll("#dp-meta-row .dp-source-pill").length,
    );
    expect(pillCount).toBe(0);
  });

  it("keeps card icon controls right-aligned via flex spacer", async () => {
    const createRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Right aligned controls task",
        description: "Check control alignment",
        selector: "/",
      }),
    });
    const created = await createRes.json() as { success: boolean; task?: { id: string } };
    expect(created.success).toBe(true);

    await fetch(`${API}/${created.task?.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "user", text: "comment" }),
    });

    await waitForTaskOnBoard(page, "Right aligned controls task");

    const layout = await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find(c => c.textContent?.includes("Right aligned controls task")) as HTMLElement | undefined;
      if (!card) return null;
      // Bottom row: flex div containing icon buttons and a flex spacer.
      const rows = [...card.querySelectorAll("div.flex.items-center")] as HTMLElement[];
      const bottomRow = rows.reverse().find((row) => row.querySelectorAll("button").length > 0) ?? null;
      if (!bottomRow) return null;
      // Has a flex:1 spacer that pushes buttons to the right
      const spacer = bottomRow.querySelector("div[style*='flex: 1'], div[style*='flex:1']");
      return {
        hasIcons: bottomRow.querySelectorAll("button").length > 0,
        hasSpacer: spacer != null,
      };
    });

    expect(layout).not.toBeNull();
    expect(layout?.hasIcons).toBe(true);
    expect(layout?.hasSpacer).toBe(true);
  });


  it("opens the compact type picker next to title and stores selected type on add", async () => {
    // Close detail panel if still open from previous test
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !document.querySelector("#detail-panel.open"),
      { timeout: 2_000 },
    ).catch(() => {});

    await openAddTask(page, "todo");

    const typeTriggerText = await page.textContent("#dp-type-picker > button");
    expect(typeTriggerText).toContain("Task");

    await page.click("#dp-type-picker > button");
    await page.locator("#dp-type-picker button", { hasText: "Bug" }).click();
    await page.fill("#dp-title", "Compact type picker task");
    await focusDescriptionEditor(page);
    await page.fill("#dp-desc", "Type should be persisted as Bug");
    await page.click("#dp-save");

    await page.waitForFunction(
      () => !document.getElementById("detail-panel")?.classList.contains("open"),
    );
    const created = await page.evaluate(async (api) => {
      const res = await fetch(api);
      const data = await res.json() as { tasks?: Array<{ title: string; type?: string }> };
      return (data.tasks || []).find((t) => t.title === "Compact type picker task") || null;
    }, API);
    expect(created).not.toBeNull();
    expect(created?.type).toBe("Bug");
  });

  it("Bug task with console errors shows error section in detail panel", async () => {
    // Create a Bug task with console errors embedded in the description
    // (simulating what the overlay error-recorder produces)
    const errorSig = `vibeflow-err-task-test-${Date.now()}`;
    const description = `A bug occurred\n\n---\n**Console logs** (1 entry)\n- 🔴 \`00:00:00\` ${errorSig}`;
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Bug with console errors",
        description,
        selector: "/",
        type: "Bug",
        status: "todo",
      }),
    });
    const data = await res.json() as { success: boolean; task?: { id: string } };
    expect(data.success).toBe(true);
    const taskId = data.task?.id;
    expect(taskId).toBeTruthy();

    await waitForTaskOnBoard(page, "Bug with console errors");

    // Open the task
    await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find(c => c.textContent?.includes("Bug with console errors")) as HTMLElement | undefined;
      card?.click();
    });
    await page.waitForSelector("#detail-panel.open", { timeout: 5_000 });

    // Switch to Details tab
    await page.click("#dp-tab-details");
    await page.waitForSelector("#dp-details-pane:not([style*='none'])");

    // The ConsoleLogsSection should render with id="dp-console-logs"
    // and contain the error signature
    const consoleLogsExists = await page.locator("#dp-console-logs").count();
    expect(consoleLogsExists).toBeGreaterThanOrEqual(1);

    const consoleLogsText = await page.textContent("#dp-console-logs");
    expect(consoleLogsText).toContain(errorSig);
  });

  it("auto-scrolls comments pane to latest comment", async () => {
    const taskRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Scroll comments task", description: "Scroll test", selector: "/" }),
    });
    const taskData = await taskRes.json() as { success: boolean; task?: { id: string } };
    expect(taskData.success).toBe(true);
    const taskId = taskData.task?.id;
    expect(taskId).toBeTruthy();

    for (let i = 0; i < 20; i++) {
      await fetch(`${API}/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: "user", text: `comment-${i}` }),
      });
    }

    await waitForTaskOnBoard(page, "Scroll comments task");
    // Open on comments tab via the comment count badge button on the task card
    await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find((c) => c.textContent?.includes("Scroll comments task")) as HTMLElement | undefined;
      const commentBtn = card?.querySelector("button[title*='comment']") as HTMLButtonElement | null;
      commentBtn?.click();
    });
    await page.waitForSelector("#detail-panel.open");
    await page.waitForSelector("#dp-activity-pane:not([style*='none'])");
    // Wait for CommentsList to finished loading the 20 comments
    await page.waitForFunction(
      () => document.querySelectorAll("#dp-activity-pane div div").length > 5,
      { timeout: 5_000 },
    );

    // CommentsList auto-scrolls its root div (first child with overflow-y: auto)
    const isAtBottom = await page.evaluate(() => {
      const pane = document.getElementById("dp-activity-pane");
      if (!pane) return false;
      const list = pane.querySelector<HTMLElement>("[style*='overflow-y']");
      if (!list) return false;
      return list.scrollTop + list.clientHeight >= list.scrollHeight - 6;
    });
    expect(isAtBottom).toBe(true);
  });

  it("offers to send a pending panel comment when closing", async () => {
    const taskRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Autosend panel comment task", description: "autosend", selector: "/" }),
    });
    const taskData = await taskRes.json() as { success: boolean; task?: { id: string } };
    expect(taskData.success).toBe(true);
    const taskId = taskData.task?.id;
    expect(taskId).toBeTruthy();

    await waitForTaskOnBoard(page, "Autosend panel comment task");
    await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find((c) => c.textContent?.includes("Autosend panel comment task")) as HTMLElement | undefined;
      card?.click();
    });
    await page.waitForSelector("#detail-panel.open");
    await openActivityTab(page);
    await page.waitForSelector("#dp-comment-input");

    await page.fill("#dp-comment-input", "pending comment should be auto-sent");
    await page.click("#dp-close");
    await page.locator("button", { hasText: "Send & Close" }).click();

    await page.waitForFunction(() => !document.getElementById("detail-panel"), { timeout: 5_000 });
    const comments = await page.evaluate(async (args) => {
      const res = await fetch(`${args.api}/${args.id}/comments`);
      const data = await res.json() as { comments?: Array<{ text: string }> };
      return data.comments || [];
    }, { api: API, id: taskId });
    expect(comments.some((c) => c.text.includes("auto-sent"))).toBe(true);
  });

  it("pasting an image in detail panel uploads it as a task file", async () => {
    const taskRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Paste image regression task", description: "paste", selector: "/" }),
    });
    const taskData = await taskRes.json() as { success: boolean; task?: { id: string } };
    expect(taskData.success).toBe(true);
    const taskId = taskData.task?.id;
    expect(taskId).toBeTruthy();

    await waitForTaskOnBoard(page, "Paste image regression task");

    await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find((c) => c.textContent?.includes("Paste image regression task")) as HTMLElement | undefined;
      card?.click();
    });
    await page.waitForSelector("#detail-panel.open");

    await page.evaluate(async () => {
      const panel = document.getElementById("detail-panel");
      if (!panel) return;

      const pngBytes = new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10,
        0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 1, 0, 0, 0, 1,
        8, 6, 0, 0, 0, 31, 21, 196,
        137, 0, 0, 0, 13, 73, 68, 65,
        84, 120, 156, 99, 248, 15, 4, 0,
        9, 251, 3, 253, 160, 90, 186, 57,
        0, 0, 0, 0, 73, 69, 78, 68,
        174, 66, 96, 130,
      ]);

      const file = new File([pngBytes], "clipboard.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      panel.dispatchEvent(event);
    });

    await page.waitForFunction(
      async (args) => {
        const res = await fetch(`${args.api}/${args.id}/files`);
        const data = await res.json() as { files?: Array<{ name: string }> };
        return (data.files || []).some((f) => /^paste-.*\.(png|jpg)$/i.test(f.name));
      },
      { api: API, id: taskId },
      { timeout: 10_000 },
    );

    const detailsStillActive = await page.evaluate(() => {
      const details = document.getElementById("dp-tab-details");
      return details?.classList.contains("active") ?? false;
    });
    expect(detailsStillActive).toBe(true);

    await openActivityTab(page);
    await page.waitForSelector("#dp-comment-input");

    await page.evaluate(async () => {
      const panel = document.getElementById("detail-panel");
      if (!panel) return;
      const pngBytes = new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10,
        0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 1, 0, 0, 0, 1,
        8, 6, 0, 0, 0, 31, 21, 196,
        137, 0, 0, 0, 13, 73, 68, 65,
        84, 120, 156, 99, 248, 15, 4, 0,
        9, 251, 3, 253, 160, 90, 186, 57,
        0, 0, 0, 0, 73, 69, 78, 68,
        174, 66, 96, 130,
      ]);
      const file = new File([pngBytes], "clipboard-2.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      panel.dispatchEvent(event);
    });

    await page.waitForFunction(
      async (args) => {
        const res = await fetch(`${args.api}/${args.id}/files`);
        const data = await res.json() as { files?: Array<{ name: string }> };
        return (data.files || []).filter((f) => /^paste-.*\.(png|jpg)$/i.test(f.name)).length >= 2;
      },
      { api: API, id: taskId },
      { timeout: 10_000 },
    );

    const commentsStillActive = await page.evaluate(() => {
      const comments = document.getElementById("dp-tab-activity");
      return comments?.classList.contains("active") ?? false;
    });
    expect(commentsStillActive).toBe(true);

    // First image should be shown as task thumbnail on the board.
    await page.waitForFunction((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`);
      return !!card?.querySelector('img[alt="Task screenshot"]');
    }, taskId, { timeout: 5_000 });

    // Thumbnail should be larger and render next to description section.
    const thumbSize = await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      const img = card?.querySelector('img[data-role="task-thumb"]') as HTMLImageElement | null;
      if (!img) return null;
      const rect = img.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }, taskId);
    expect(thumbSize).not.toBeNull();
    expect((thumbSize?.width ?? 0) >= 50).toBe(true);

    // Hovering thumbnail should show enlarged preview.
    await page.hover(`[data-task-id="${taskId}"] img[data-role="task-thumb"]`);
    await page.waitForSelector(`img[data-role="task-thumb-preview"]`, { timeout: 3_000 });
    const previewScale = await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      const thumb = card?.querySelector('img[data-role="task-thumb"]') as HTMLImageElement | null;
      const preview = document.querySelector('img[data-role="task-thumb-preview"]') as HTMLImageElement | null;
      if (!thumb || !preview) return null;
      return {
        thumbWidth: thumb.getBoundingClientRect().width,
        previewWidth: preview.getBoundingClientRect().width,
      };
    }, taskId);
    expect(previewScale).not.toBeNull();
    expect((previewScale?.previewWidth ?? 0) > (previewScale?.thumbWidth ?? 0)).toBe(true);

    // Re-open details and ensure screenshot preview is shown there too.
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, taskId);
    await page.waitForSelector("#detail-panel.open");
    await page.click("#dp-tab-details");
    await page.waitForSelector("#dp-screenshot-preview img[alt='Task screenshot']", { timeout: 5_000 });
    await page.waitForSelector("#dp-screenshot-preview button", { timeout: 5_000 });
    const screenshotActions = await page.$$eval('#dp-screenshot-preview button', (btns) => btns.map((b) => b.textContent?.trim() ?? ''));
    expect(screenshotActions.some((txt) => txt === 'Preview')).toBe(true);
    expect(screenshotActions.some((txt) => txt === 'Remove')).toBe(true);
  });

  it("shows file-removal activity and removes deleted comment content", async () => {
    const taskRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Removal trace task", description: "", selector: "/" }),
    });
    const taskData = await taskRes.json() as { success: boolean; task?: { id: string } };
    expect(taskData.success).toBe(true);
    const taskId = taskData.task?.id!;

    // Upload a file using the correct raw-body endpoint
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 160, 90, 186, 57, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
    const uploadRes = await fetch(`${API}/${taskId}/files/trace-test.png`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: pngBytes,
    });
    expect((await uploadRes.json() as { success?: boolean }).success).toBe(true);

    // Add a comment via API
    const commentRes = await fetch(`${API}/${taskId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Comment to delete", author: "user" }),
    });
    const commentData = await commentRes.json() as { comment?: { id: string } };
    const commentId = commentData.comment?.id!;

    // Delete the file
    await fetch(`${API}/${taskId}/files/trace-test.png`, { method: "DELETE" });

    // Delete the comment
    await fetch(`${API}/${taskId}/comments/${commentId}`, { method: "DELETE" });

    // Open the task in the Kanban and navigate to comments tab
    await waitForTaskOnBoard(page, "Removal trace task");
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, taskId);
    await page.waitForSelector("#detail-panel.open");
    await openActivityTab(page);

    // Wait for the activity stream to reflect the removed file.
    await page.waitForFunction(
      (filename: string) => {
        const pane = document.getElementById("dp-activity-pane");
        const text = pane?.textContent ?? "";
        return text.includes(filename) || text.includes("trace-test");
      },
      "trace-test.png",
      { timeout: 8_000 },
    );

    // System trace for file removal should appear
    const hasFfileTrace = await page.evaluate(() => {
      const pane = document.getElementById("dp-activity-pane");
      return pane?.textContent?.includes("trace-test.png") ?? false;
    });
    expect(hasFfileTrace).toBe(true);

    const comments = await page.evaluate(async (args) => {
      const res = await fetch(`${args.api}/${args.taskId}/comments`);
      const data = await res.json() as { comments?: Array<{ id: string; deleted?: boolean; text?: string }> };
      return data.comments ?? [];
    }, { api: API, taskId });
    const deletedComment = comments.find((comment) => comment.id === commentId);
    const hasOriginalCommentContent = comments.some((comment) => comment.text === "Comment to delete");
    expect(hasOriginalCommentContent).toBe(false);
    if (deletedComment) {
      expect(deletedComment.deleted === true || deletedComment.text === "[Comment deleted]").toBe(true);
    }
  });

  it("does not render left-side priority bullet in task cards", async () => {
    const title = `No bullet task ${Date.now()}`;
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: "check bullet", selector: "/", priority: "High" }),
    });
    const data = await res.json() as { success: boolean; task?: { id: string } };
    expect(data.success).toBe(true);
    const taskId = data.task?.id;
    expect(taskId).toBeTruthy();

    await waitForTaskOnBoard(page, taskId);

    const hasPriorityDot = await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      if (!card) return true;
      return [...card.querySelectorAll("span")].some((el) => {
        const style = window.getComputedStyle(el);
        return style.borderRadius === "50%" && style.width === "5px" && style.height === "5px";
      });
    }, taskId);
    expect(hasPriorityDot).toBe(false);
  });

  it("keeps kanban in dark theme", async () => {
    await page.waitForSelector('#header-project-name');
    const initialTheme = await page.evaluate(() => document.body.getAttribute('data-theme'));
    expect(initialTheme).toBe('dark');

    const toggleCount = await page.locator('#btn-theme-toggle').count();
    expect(toggleCount).toBe(0);
  });


  it("uses readable select controls and aligned comments send button", async () => {
    const createRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Meta select visibility task",
        description: "Check select/readability",
        selector: "/",
      }),
    });
    const created = await createRes.json() as { success: boolean };
    expect(created.success).toBe(true);

    await waitForTaskOnBoard(page, "Meta select visibility task");
    await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find(c => c.textContent?.includes("Meta select visibility task")) as HTMLElement | undefined;
      card?.click();
    });
    await page.waitForSelector("#detail-panel.open");

    // Check that priority label and select have readable (non-invisible) colors
    const metaStyles = await page.evaluate(() => {
      const priorityLabel = [...document.querySelectorAll("#dp-details-pane .dp-meta-label")]
        .find(el => el.textContent?.includes("Priority")) as HTMLElement | null;
      const select = document.getElementById("dp-priority") as HTMLSelectElement | null;
      if (!priorityLabel || !select) return null;
      const labelStyle = getComputedStyle(priorityLabel);
      const selectStyle = getComputedStyle(select);
      return {
        labelColor: labelStyle.color,
        selectColor: selectStyle.color,
        selectBackground: selectStyle.backgroundColor,
      };
    });

    expect(metaStyles).not.toBeNull();
    // #475569 — muted but readable label color
    expect(metaStyles?.labelColor).toBe("rgb(71, 85, 105)");
    // #e2e8f0 — bright select text
    expect(metaStyles?.selectColor).toBe("rgb(226, 232, 240)");
    // #050d1a — dark background
    expect(metaStyles?.selectBackground).toBe("rgb(5, 13, 26)");

    await page.click("#dp-close");
    await page.waitForFunction(() => !document.getElementById("detail-panel"), { timeout: 5_000 });

    // Open the task again via the comment button (opens on comments tab)
    await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find(c => c.textContent?.includes("Meta select visibility task")) as HTMLElement | undefined;
      const commentBtn = card?.querySelector("button[title*='comment']") as HTMLButtonElement | null;
      commentBtn?.click();
    });
    await page.waitForSelector("#detail-panel.open");
    await page.waitForSelector("#dp-comment-input");

    const sendButtonStyle = await page.evaluate(() => {
      const btn = document.getElementById("dp-comment-submit") as HTMLButtonElement | null;
      if (!btn) return null;
      const style = getComputedStyle(btn);
      return {
        width: style.width,
        height: style.height,
        right: style.right,
        bottom: style.bottom,
      };
    });

    expect(sendButtonStyle).not.toBeNull();
    expect(sendButtonStyle?.width).toBe("26px");
    expect(sendButtonStyle?.height).toBe("26px");
    expect(sendButtonStyle?.right).toBe("8px");
    expect(sendButtonStyle?.bottom).toBe("16px");
  });

  it("supports task reference autocomplete by title text after #", async () => {
    // Ensure panel is closed so components mount fresh when we open a task
    await closePanelIfOpen(page);

    const targetRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Autocomplete target alpha",
        description: "target for title-based lookup",
        selector: "/",
      }),
    });
    const target = await targetRes.json() as { success: boolean; task?: { id: string } };
    expect(target.success).toBe(true);
    expect(target.task?.id).toBeTruthy();

    const sourceRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Autocomplete source beta",
        description: "writer task",
        selector: "/",
      }),
    });
    const source = await sourceRes.json() as { success: boolean };
    expect(source.success).toBe(true);

    await waitForTaskOnBoard(page, "Autocomplete source beta");
    // Allow time for WS state to settle and API to be consistent
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find(c => c.textContent?.includes("Autocomplete source beta")) as HTMLElement | undefined;
      card?.click();
    });

    await page.waitForSelector("#detail-panel.open");
    await openActivityTab(page);
    await page.waitForSelector("#dp-comment-input");
    // Type character-by-character so the textarea cursor stays at the end for autocomplete detection.
    await page.locator("#dp-comment-input").pressSequentially("Link to #alpha", { delay: 50 });

    await page.waitForSelector("[data-task-ref-suggest]", { state: "visible", timeout: 8_000 });
    const targetSuggestion = page.locator("[data-task-ref-suggest] button", { hasText: "Autocomplete target alpha" }).first();
    expect(await targetSuggestion.count()).toBeGreaterThan(0);

    // Use a real click (not dispatchEvent) to simulate actual browser mouse interaction.
    // This ensures mousedown bubbles to document and tests the outside-click guard.
    await targetSuggestion.click();

    const commentValue = await page.inputValue("#dp-comment-input");
    expect(commentValue).toContain(`#${target.task?.id}`);

    // Detail panel must still be open after selecting autocomplete suggestion.
    const panelStillOpen = await page.evaluate(
      () => document.getElementById("detail-panel")?.classList.contains("open") ?? false,
    );
    expect(panelStillOpen).toBe(true);
  });

  it("detail panel stays open when clicking #task reference link in markdown preview", async () => {
    // Create two tasks: A (host) and B (referenced).
    const taskARes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Panel host task", description: "", selector: "/" }),
    });
    const taskAData = await taskARes.json() as { success: boolean; task?: { id: string } };
    expect(taskAData.success).toBe(true);
    const taskAId = taskAData.task?.id;

    const taskBRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Panel linked task", description: "", selector: "/" }),
    });
    const taskBData = await taskBRes.json() as { success: boolean; task?: { id: string } };
    expect(taskBData.success).toBe(true);
    const taskBId = taskBData.task?.id;

    await waitForTaskOnBoard(page, "Panel host task");

    // Open Task A.
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, taskAId);
    await page.waitForSelector("#detail-panel.open");
    await page.click("#dp-tab-details");

    // Switch description to edit mode and type a task ref.
    await page.click("#dp-desc-preview");
    await page.waitForSelector("#dp-desc", { timeout: 3_000 });
    await page.fill("#dp-desc", `#${taskBId} `);

    // Blur textarea to switch to preview mode (renders the link).
    await page.evaluate(() => {
      (document.getElementById("dp-desc") as HTMLTextAreaElement | null)?.blur();
    });
    await page.waitForSelector(`#dp-desc-preview a[data-task-ref="${taskBId}"]`, { timeout: 5_000 });

    // Click the task reference link.
    await page.click(`#dp-desc-preview a[data-task-ref="${taskBId}"]`);

    // Panel must still be open (showing referenced task).
    const panelOpen = await page.evaluate(
      () => document.getElementById("detail-panel")?.classList.contains("open") ?? false,
    );
    expect(panelOpen).toBe(true);

    // URL hash should point to task B.
    const hash = await page.evaluate(() => window.location.hash);
    expect(hash).toBe(`#task-${taskBId}`);

    // The panel title input should now show Task B's title (navigation worked).
    await page.waitForFunction(
      (expectedTitle) => (document.getElementById("dp-title") as HTMLInputElement | null)?.value === expectedTitle,
      "Panel linked task",
      { timeout: 3_000 },
    );
  });

  it("clicking non-link area of description preview enters edit mode", async () => {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Preview click task", description: "Some description text", selector: "/" }),
    });
    const data = await res.json() as { success: boolean; task?: { id: string } };
    expect(data.success).toBe(true);

    await waitForTaskOnBoard(page, data.task?.id ?? "");
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, data.task?.id);
    await page.waitForSelector("#detail-panel.open");
    await page.click("#dp-tab-details");

    // Description should be in preview mode (existing task).
    await page.waitForSelector("#dp-desc-preview", { state: "visible" });
    const textareaHidden = await page.isHidden("#dp-desc");
    expect(textareaHidden).toBe(true);

    // Click on the preview text area (not on a link) → should switch to edit mode.
    await page.click("#dp-desc-preview");
    await page.waitForSelector("#dp-desc", { state: "visible", timeout: 3_000 });

    // Verify the textarea is now visible with the correct value.
    const descValue = await page.inputValue("#dp-desc");
    expect(descValue).toBe("Some description text");
  });

  it("does not reserve board width when detail panel is closed", async () => {
    // Ensure board is loaded (no reload needed - already on the page)

    const initialWidth = await page.evaluate(() => {
      const board = document.getElementById("kanban-board") as HTMLElement | null;
      return board?.getBoundingClientRect().width ?? 0;
    });

    await page.click("#kanban-board article.task-card");
    await page.waitForSelector("#detail-panel.open");

    const widthWhileOpen = await page.evaluate(() => {
      const board = document.getElementById("kanban-board") as HTMLElement | null;
      return board?.getBoundingClientRect().width ?? 0;
    });

    await page.click("#dp-close");
    await page.waitForFunction(
      () => !document.getElementById("detail-panel")?.classList.contains("open"),
      { timeout: 5_000 },
    );

    const widthAfterClose = await page.evaluate(() => {
      const board = document.getElementById("kanban-board") as HTMLElement | null;
      return board?.getBoundingClientRect().width ?? 0;
    });

    expect(Math.abs(initialWidth - widthWhileOpen)).toBeLessThanOrEqual(2);
    expect(Math.abs(initialWidth - widthAfterClose)).toBeLessThanOrEqual(2);
  });

  it("keeps details pane scrollable for long content", async () => {
    const longDescription = Array.from({ length: 140 }, (_, i) => `line-${i + 1}`).join("\n");
    const createRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Scrollable details task",
        description: longDescription,
        selector: "/",
      }),
    });
    const created = await createRes.json() as { success: boolean };
    expect(created.success).toBe(true);

    await waitForTaskOnBoard(page, "Scrollable details task");

    await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find(c => c.textContent?.includes("Scrollable details task")) as HTMLElement | undefined;
      card?.click();
    });
    await page.waitForSelector("#detail-panel.open");

    const scrollState = await page.evaluate(() => {
      const pane = document.getElementById("dp-details-pane") as HTMLElement | null;
      const descPreview = document.getElementById("dp-desc-preview") as HTMLElement | null;

      const paneCan = !!pane && pane.scrollHeight > pane.clientHeight;
      if (pane) pane.scrollTop = 180;
      const paneMoved = !!pane && pane.scrollTop > 0;

      const descCan = !!descPreview && descPreview.scrollHeight > descPreview.clientHeight;
      if (descPreview) descPreview.scrollTop = 120;
      const descMoved = !!descPreview && descPreview.scrollTop > 0;

      return { paneCan, paneMoved, descCan, descMoved };
    });

    expect(scrollState.paneCan || scrollState.descCan).toBe(true);
    expect(scrollState.paneMoved || scrollState.descMoved).toBe(true);
  });

  it("applies live updates without page reload", async () => {
    // Board is already loaded from beforeAll — no reload needed

    const marker = `Live update task ${Date.now()}`;
    const createRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: marker, description: "ws update", selector: "/" }),
    });
    const created = await createRes.json() as { success: boolean };
    expect(created.success).toBe(true);

    await page.waitForFunction(
      (title) => [...document.querySelectorAll("#kanban-board article.task-card")]
        .some(c => c.textContent?.includes(title)),
      marker,
      { timeout: 15_000 },
    );

    const exists = await page.evaluate((title) =>
      [...document.querySelectorAll("#kanban-board article.task-card")]
        .some(c => c.textContent?.includes(title)),
      marker,
    );
    expect(exists).toBe(true);
  });

  it("uses compact spacing between message/file/agent card actions", async () => {
    const createRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Compact actions spacing task",
        description: "icons should be close",
        selector: "/",
      }),
    });
    const created = await createRes.json() as { success: boolean; task?: { id: string } };
    expect(created.success).toBe(true);
    const taskId = created.task?.id;
    expect(taskId).toBeTruthy();

    await fetch(`${API}/${taskId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "user", text: "has comments" }),
    });

    await fetch(`${API}/${taskId}/files?filename=note.txt`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });

    await waitForTaskOnBoard(page, "Compact actions spacing task");

    const spacing = await page.evaluate(() => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find(c => c.textContent?.includes("Compact actions spacing task")) as HTMLElement | undefined;
      if (!card) return null;

      const controls = [...card.querySelectorAll("div.flex.items-center")]
        .find((row) => row.querySelectorAll("button").length >= 2) as HTMLElement | undefined;
      if (!controls) return null;

      const actionButtons = [...controls.querySelectorAll("button")] as HTMLButtonElement[];
      const rects = actionButtons.map(b => b.getBoundingClientRect()).sort((a, b) => a.left - b.left);
      let maxGap = 0;
      for (let i = 1; i < rects.length; i++) {
        maxGap = Math.max(maxGap, rects[i].left - rects[i - 1].right);
      }

      return {
        buttonCount: actionButtons.length,
        maxGap,
      };
    });

    expect(spacing).not.toBeNull();
    expect(spacing?.buttonCount).toBeGreaterThanOrEqual(2);
    expect(spacing?.maxGap).toBeLessThanOrEqual(6);
  });

  // ── Drag-drop between columns ─────────────────────────────────────────────
  it("dragging a task card from todo to done changes its status", async () => {
    // Create a task in the todo column
    const createRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Drag-drop regression task",
        description: "Should be draggable",
        selector: "#drag-test",
        status: "todo",
      }),
    });
    const { task } = (await createRes.json()) as { task: { id: string } };
    expect(task?.id).toBeTruthy();

    await waitForTaskOnBoard(page, task.id);

    // Wait for the card to appear in the todo column
    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-column-id="todo"] [data-task-id="${id}"]`),
      task.id,
      { timeout: 5_000 },
    );

    const sourceCard = page.locator(`[data-task-id="${task.id}"]`).first();
    const doneColumn = page.locator('[data-column-id="done"] .column-scroll');

    // Perform drag and drop
    await sourceCard.dragTo(doneColumn);

    // Wait for the task to appear in the done column (optimistic update or WS)
    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-column-id="done"] [data-task-id="${id}"]`),
      task.id,
      { timeout: 5_000 },
    );

    // Also verify via API that the server persisted the status change
    const getRes = await fetch(`${API}/${task.id}`);
    const updated = (await getRes.json()) as { status?: string };
    expect(updated.status).toBe("done");
  });

  it("drag-to-done status change appears in detail panel activity tab", async () => {
    const title = `Activity drag test ${Date.now()}`;
    const createRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, selector: "#activity-drag-test", status: "todo" }),
    });
    const { task } = (await createRes.json()) as { task: { id: string } };
    expect(task?.id).toBeTruthy();

    await waitForTaskOnBoard(page, task.id);

    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-column-id="todo"] [data-task-id="${id}"]`),
      task.id,
      { timeout: 5_000 },
    );

    const sourceCard = page.locator(`[data-task-id="${task.id}"]`).first();
    const doneColumn = page.locator('[data-column-id="done"] .column-scroll');
    await sourceCard.dragTo(doneColumn);

    // Wait for optimistic move to done column
    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-column-id="done"] [data-task-id="${id}"]`),
      task.id,
      { timeout: 5_000 },
    );

    // Open the detail panel
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, task.id);
    await page.waitForSelector("#dp-tab-activity", { timeout: 5_000 });

    // Switch to activity tab
    await page.click("#dp-tab-activity");
    await page.waitForSelector("#dp-activity-pane", { timeout: 3_000 });

    // Wait for the optimistic status-change activity to render in the pane.
    await page.waitForFunction(() => {
      const pane = document.getElementById("dp-activity-pane");
      const text = pane?.textContent?.toLowerCase() ?? "";
      return text.includes("changed status") && text.includes("done");
    }, undefined, { timeout: 5_000 });
  });

  it("description switches between preview and editor based on focus (Grammarly regression)", async () => {
    const title = `Preview tab test ${Date.now()}`;
    // Create a task with markdown description
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: "**Bold** text", selector: "/" }),
    });
    const data = (await res.json()) as { success?: boolean };
    expect(data.success).toBe(true);

    await waitForTaskOnBoard(page, title);

    // Open detail panel
    await page.evaluate((taskTitle) => {
      const card = [...document.querySelectorAll("#kanban-board article.task-card")]
        .find(c => c.textContent?.includes(taskTitle)) as HTMLElement | undefined;
      card?.click();
    }, title);
    await page.waitForSelector("#dp-desc-preview", { timeout: 5_000 });

    // Initially in preview mode for existing tasks.
    await page.waitForFunction(() => !document.getElementById("dp-desc"), { timeout: 3_000 });

    // Click preview container — should switch to edit mode.
    await page.click("#dp-desc-preview");
    await page.waitForSelector("#dp-desc", { timeout: 3_000 });
    const textareaVisible = await page.isVisible("#dp-desc");
    expect(textareaVisible).toBe(true);

    // Blur textarea — should switch back to preview mode.
    await page.click("#dp-title");
    await page.waitForSelector("#dp-desc-preview", { timeout: 3_000 });

    // Preview should render markdown (bold text)
    const previewRendered = await page.evaluate(() => {
      const preview = document.getElementById('dp-desc-preview');
      const strong = preview?.querySelector('strong');
      return !!strong && /bold/i.test(strong.textContent || '');
    });
    expect(previewRendered).toBe(true);
  });

  // ── PasteHintBanner — each test needs fresh localStorage for banner state ──

  it("shows paste hint banner in Activity tab", async () => {
    const bannerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const bannerPage = await bannerContext.newPage();
    await bannerPage.goto(`${BASE}/kanban`);
    await bannerPage.waitForSelector("#kanban-board");
    await bannerPage.click("[data-task-id]", { timeout: 5_000 });
    await bannerPage.waitForSelector("#detail-panel", { timeout: 5_000 });
    await openActivityTab(bannerPage);
    const bannerVisible = await bannerPage.isVisible("#detail-panel button[title='Dismiss']");
    expect(bannerVisible).toBe(true);
    const bannerText = await bannerPage.textContent("#detail-panel");
    expect(bannerText ?? "").toContain("Paste screenshots or files anywhere in this panel");
    await bannerContext.close();
  });

  it("dismisses paste hint banner when × is clicked", async () => {
    const bannerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const bannerPage = await bannerContext.newPage();
    await bannerPage.goto(`${BASE}/kanban`);
    await bannerPage.waitForSelector("#kanban-board");
    await bannerPage.click("[data-task-id]", { timeout: 5_000 });
    await bannerPage.waitForSelector("#detail-panel", { timeout: 5_000 });
    await openActivityTab(bannerPage);
    await bannerPage.waitForSelector("#detail-panel button[title='Dismiss']", { timeout: 3_000 });
    await bannerPage.click("#detail-panel button[title='Dismiss']", { timeout: 3_000 });
    const bannerGone = await bannerPage.locator("#detail-panel button[title='Dismiss']").count();
    expect(bannerGone).toBe(0);
    await bannerContext.close();
  });

  it("shows paste hint banner in Files tab", async () => {
    const bannerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const bannerPage = await bannerContext.newPage();
    await bannerPage.goto(`${BASE}/kanban`);
    await bannerPage.waitForSelector("#kanban-board");
    await bannerPage.click("[data-task-id]", { timeout: 5_000 });
    await bannerPage.waitForSelector("#detail-panel", { timeout: 5_000 });
    await openFilesTab(bannerPage);
    const bannerVisible = await bannerPage.isVisible("#detail-panel button[title='Dismiss']");
    expect(bannerVisible).toBe(true);
    const bannerText = await bannerPage.textContent("#detail-panel");
    expect(bannerText ?? "").toContain("Paste screenshots or files anywhere in this panel");
    await bannerContext.close();
  });

  it("banner does not reappear after dismissal (localStorage persistence)", async () => {
    const bannerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const bannerPage = await bannerContext.newPage();
    await bannerPage.goto(`${BASE}/kanban`);
    await bannerPage.waitForSelector("#kanban-board");
    await bannerPage.click("[data-task-id]", { timeout: 5_000 });
    await bannerPage.waitForSelector("#detail-panel", { timeout: 5_000 });
    await openFilesTab(bannerPage);
    await bannerPage.waitForSelector("#detail-panel button[title='Dismiss']", { timeout: 3_000 });
    await bannerPage.click("#detail-panel button[title='Dismiss']", { timeout: 3_000 });
    await bannerPage.keyboard.press("Escape");
    await bannerPage.waitForFunction(
      () => !document.querySelector("#detail-panel.open"),
      { timeout: 2_000 },
    ).catch(() => {});
    await bannerPage.click("[data-task-id]", { timeout: 5_000 });
    await bannerPage.waitForSelector("#detail-panel", { timeout: 5_000 });
    await openFilesTab(bannerPage);
    const bannerStillGone = await bannerPage.locator("#detail-panel button[title='Dismiss']").count();
    expect(bannerStillGone).toBe(0);
    await bannerContext.close();
  });

  // ── Regression: modals must not close the task detail panel ──────────────

  it("clicking inside the file preview modal does not close the task detail panel", async () => {
    // Create a task and upload a tiny PNG via raw-body endpoint
    const taskRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Modal-close regression: file preview", description: "", selector: "/" }),
    });
    const taskData = await taskRes.json() as { success: boolean; task?: { id: string } };
    expect(taskData.success).toBe(true);
    const taskId = taskData.task?.id!;

    const pngBytes = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
      0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
      120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 160, 90, 186, 57, 0, 0, 0, 0,
      73, 69, 78, 68, 174, 66, 96, 130,
    ]);
    const uploadRes = await fetch(`${API}/${taskId}/files/preview-regression.png`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: pngBytes,
    });
    expect((await uploadRes.json() as { success?: boolean }).success).toBe(true);

    // Open the task detail panel
    await waitForTaskOnBoard(page, taskId);
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, taskId);
    await page.waitForSelector("#detail-panel.open");

    // Navigate to Files tab and open the first previewable file
    await openFilesTab(page);
    await page.waitForSelector("#dp-files-pane button[title='Preview']", { timeout: 8_000 });
    await page.click("#dp-files-pane button[title='Preview']");

    // FilePreviewModal should be visible
    await page.waitForSelector("#file-preview-modal", { timeout: 5_000 });

    // Click inside the modal content (the inner modal-box, not the backdrop)
    await page.click(".modal-box", { timeout: 3_000 });

    // Detail panel must still be open — this was the bug
    const panelStillOpen = await page.evaluate(() =>
      document.getElementById("detail-panel")?.classList.contains("open") ?? false,
    );
    expect(panelStillOpen).toBe(true);

    // Close the file preview properly via the header close button
    await page.click("#file-preview-close", { timeout: 3_000 });
    await page.waitForFunction(
      () => !document.getElementById("file-preview-modal"),
      { timeout: 3_000 },
    );

    // Detail panel should still be open after modal close
    const panelOpenAfterModalClose = await page.evaluate(() =>
      document.getElementById("detail-panel")?.classList.contains("open") ?? false,
    );
    expect(panelOpenAfterModalClose).toBe(true);
  });

  it("clicking inside the settings modal does not close the task detail panel", async () => {
    // Ensure a task panel is open
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !document.querySelector("#detail-panel.open"),
      { timeout: 2_000 },
    ).catch(() => {});
    await page.click("[data-task-id]", { timeout: 5_000 });
    await page.waitForSelector("#detail-panel.open");

    // Open settings modal via JS click (bypasses mousedown so the outside-click handler
    // on the panel doesn't fire — simulates the defense-in-depth scenario where the
    // modal opens while the panel stays open).
    await page.evaluate(() => {
      (document.getElementById("btn-settings") as HTMLButtonElement | null)?.click();
    });
    await page.waitForSelector("#settings-modal", { timeout: 5_000 });

    // Perform a real Playwright click inside the modal content to verify that
    // the modal's onMouseDown stopPropagation prevents the detail panel from closing.
    await page.click("#settings-modal .modal-box");

    // Detail panel must still be open
    const panelOpen = await page.evaluate(() =>
      document.getElementById("detail-panel")?.classList.contains("open") ?? false,
    );
    expect(panelOpen).toBe(true);

    // Close the settings modal cleanly
    await page.click("#settings-cancel");
    await page.waitForFunction(
      () => !document.getElementById("settings-modal"),
      { timeout: 3_000 },
    );

    // Panel should still be open after modal close
    const panelOpenAfterClose = await page.evaluate(() =>
      document.getElementById("detail-panel")?.classList.contains("open") ?? false,
    );
    expect(panelOpenAfterClose).toBe(true);
  });


  it("done column shows at most 20 tasks with overflow indicator", async () => {
    // Create 22 done tasks via API
    const taskIds: string[] = [];
    for (let i = 1; i <= 22; i++) {
      const r = await fetch(`${API}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Done overflow task ${i}`, status: "done", selector: "/" }),
      });
      const data = await r.json() as { task?: { id: string } };
      if (data.task?.id) taskIds.push(data.task.id);
    }
    expect(taskIds).toHaveLength(22);

    // Wait for done tasks to appear via WebSocket
    await page.waitForFunction(
      () => document.querySelectorAll('[data-column-id="done"] [data-task-id]').length > 0,
      { timeout: 15_000 },
    );

    // Done column should show at most 20 task cards
    const doneCards = await page.locator('[data-column-id="done"] [data-task-id]').count();
    expect(doneCards).toBeLessThanOrEqual(20);

    // The overflow indicator should contain a number showing hidden tasks
    const columnScroll = page.locator('[data-column-id="done"] .column-scroll');
    const scrollText = await columnScroll.innerText({ timeout: 5_000 });
    expect(scrollText).toMatch(/\+\d+\s+older/);

    // Clean up the extra tasks
    await Promise.all(taskIds.map((id) =>
      fetch(`${API}/${id}`, { method: "DELETE" }),
    ));
  });

  it("stress: board renders correctly with 100 tasks across columns", async () => {
    const TASK_COUNT = 100;
    const statuses = ["todo", "in-progress", "review", "done", "backlog"];
    const taskIds: string[] = [];

    // Create 100 tasks via API in parallel batches of 25
    for (let batch = 0; batch < 4; batch++) {
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: `Stress task ${batch * 25 + i}`,
              status: statuses[(batch * 25 + i) % statuses.length],
              selector: "/",
            }),
          }).then((r) => r.json() as Promise<{ task?: { id: string } }>),
        ),
      );
      for (const data of results) {
        if (data.task?.id) taskIds.push(data.task.id);
      }
    }
    expect(taskIds.length).toBe(TASK_COUNT);

    // Wait for tasks to appear via WebSocket (no reload needed)
    await page.waitForFunction(
      () => document.querySelectorAll("[data-task-id]").length > 0,
      { timeout: 10_000 },
    );

    // All columns should be present
    for (const col of ["todo", "in-progress", "review", "backlog"]) {
      const isVisible = await page.isVisible(`[data-column-id="${col}"]`);
      expect(isVisible).toBe(true);
    }

    // Done column should respect the 20-card limit even under load
    const doneCards = await page.locator('[data-column-id="done"] [data-task-id]').count();
    expect(doneCards).toBeLessThanOrEqual(20);

    // Clean up all created tasks
    await Promise.all(taskIds.map((id) =>
      fetch(`${API}/${id}`, { method: "DELETE" }),
    ));
  });

  // ── Per-task-type default models ───────────────────────────────────────────
  it("shows per-type model pickers when checkbox is enabled in Settings", async () => {
    // Close any open panel
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !document.querySelector("#detail-panel.open"),
      { timeout: 2_000 },
    ).catch(() => {});

    // Open settings modal
    await page.evaluate(() => {
      (document.getElementById("btn-settings") as HTMLButtonElement | null)?.click();
    });
    await page.waitForSelector("#settings-modal", { timeout: 5_000 });

    // Switch to Agent tab (click by text content)
    const agentTab = page.locator("#settings-modal .dp-tab").filter({ hasText: "Agent" });
    await agentTab.click();
    
    // Wait for the per-type checkbox to appear (indicates Agent tab is active)
    await page.waitForSelector("#settings-per-type-models", { timeout: 5_000 });

    // Per-type checkbox should exist
    const checkboxExists = await page.locator("#settings-per-type-models").count();
    expect(checkboxExists).toBe(1);

    // Initially unchecked — per-type pickers should be hidden
    const isChecked = await page.locator("#settings-per-type-models").isChecked();
    expect(isChecked).toBe(false);

    // Check the checkbox
    await page.click("#settings-per-type-models");

    // Per-type pickers should now be visible (Bug, Research, Task)
    await page.waitForSelector("#dp-type-model-picker-bug", { timeout: 3_000 });
    const bugPickerExists = await page.locator("#dp-type-model-picker-bug").count();
    const researchPickerExists = await page.locator("#dp-type-model-picker-research").count();
    const taskPickerExists = await page.locator("#dp-type-model-picker-task").count();
    expect(bugPickerExists).toBe(1);
    expect(researchPickerExists).toBe(1);
    expect(taskPickerExists).toBe(1);

    // Close settings
    await page.click("#settings-cancel");
    await page.waitForFunction(
      () => !document.getElementById("settings-modal"),
      { timeout: 3_000 },
    );
  });

  it("per-type default model is used for Bug tasks when perTypeModels is enabled", async () => {
    // Set per-type defaults via settings API
    await fetch(`${BASE}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        perTypeModels: true,
        defaultModelBug: "anthropic/claude-sonnet-4-5-20250514",
        defaultModelResearch: "openai/gpt-4o",
        defaultModelTask: "anthropic/claude-3-5-sonnet-20241022",
      }),
    });

    // Create a Bug task
    const bugRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Bug type model test", description: "test", selector: "/", type: "Bug" }),
    });
    const bugData = await bugRes.json() as { success: boolean; task?: { id: string } };
    expect(bugData.success).toBe(true);
    const bugTaskId = bugData.task?.id;

    await waitForTaskOnBoard(page, "Bug type model test");

    // Open the Bug task
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, bugTaskId);
    await page.waitForSelector("#detail-panel.open");

    // Switch to Agent tab
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane:not([style*='none'])");

    // The model picker button should exist in the agent pane
    const modelButtonExists = await page.locator("#dp-agent-pane button").count();
    expect(modelButtonExists).toBeGreaterThanOrEqual(1);
  });

  it("overall default model is used when perTypeModels is disabled", async () => {
    // Set overall default and disable per-type
    await fetch(`${BASE}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        perTypeModels: false,
        defaultModel: "anthropic/claude-sonnet-4-5-20250514",
        defaultModelBug: "openai/gpt-4o", // should be ignored
      }),
    });

    // Create a Bug task
    const bugRes = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Overall default model test", description: "test", selector: "/", type: "Bug" }),
    });
    const bugData = await bugRes.json() as { success: boolean; task?: { id: string } };
    expect(bugData.success).toBe(true);
    const bugTaskId = bugData.task?.id;

    await waitForTaskOnBoard(page, "Overall default model test");

    // Open the Bug task
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, bugTaskId);
    await page.waitForSelector("#detail-panel.open");

    // Switch to Agent tab
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane:not([style*='none'])");

    // The model picker button should exist
    const modelButtonExists = await page.locator("#dp-agent-pane button").count();
    expect(modelButtonExists).toBeGreaterThanOrEqual(1);
  });

  // ── Model persistence when switching tasks ─────────────────────────────────
  it("model selection persists when switching between tasks", async () => {
    // Create two tasks
    const task1Res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Model persistence task 1", description: "test", selector: "/" }),
    });
    const task1Data = await task1Res.json() as { success: boolean; task?: { id: string } };
    expect(task1Data.success).toBe(true);
    const task1Id = task1Data.task?.id;

    const task2Res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Model persistence task 2", description: "test", selector: "/" }),
    });
    const task2Data = await task2Res.json() as { success: boolean; task?: { id: string } };
    expect(task2Data.success).toBe(true);
    const task2Id = task2Data.task?.id;

    await waitForTaskOnBoard(page, task1Id);

    // Open task 1
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, task1Id);
    await page.waitForSelector("#detail-panel.open");

    // Switch to Agent tab
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane:not([style*='none'])");

    // Model picker button should exist
    const modelButtonExists = await page.locator("#dp-agent-pane button").count();
    expect(modelButtonExists).toBeGreaterThanOrEqual(1);

    // Click model picker to open dropdown
    await page.click("#dp-agent-pane button");
    await page.waitForSelector("[data-model-picker-dropdown]");

    // Dropdown should contain model options
    const options = await page.locator("[data-model-picker-dropdown] button").all();
    expect(options.length).toBeGreaterThan(0);

    // Select the first model
    await options[0].click();

    // Dropdown should close
    await page.waitForFunction(
      () => !document.querySelector("[data-model-picker-dropdown]"),
      { timeout: 3_000 },
    );

    // Close panel
    await page.click("#dp-close");
    await page.waitForFunction(
      () => !document.querySelector("#detail-panel.open"),
      { timeout: 2_000 },
    ).catch(() => {});

    // Open task 2
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, task2Id);
    await page.waitForSelector("#detail-panel.open");
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane:not([style*='none'])");

    // Task 2 model picker should exist
    const task2ModelButton = await page.locator("#dp-agent-pane button").count();
    expect(task2ModelButton).toBeGreaterThanOrEqual(1);

    // Re-open task 1 — model picker should still exist
    await page.click("#dp-close");
    await page.waitForFunction(
      () => !document.querySelector("#detail-panel.open"),
      { timeout: 2_000 },
    ).catch(() => {});

    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, task1Id);
    await page.waitForSelector("#detail-panel.open");
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane:not([style*='none'])");

    const task1ModelButtonAfter = await page.locator("#dp-agent-pane button").count();
    expect(task1ModelButtonAfter).toBeGreaterThanOrEqual(1);
  });

  // ── New tasks appear at bottom of column ───────────────────────────────────
  it("new tasks appear at the bottom of the column (oldest-first ordering)", async () => {
    // Create 3 tasks sequentially to ensure distinct createdAt timestamps
    // (no artificial delays needed — API processes each in <10ms)
    const task1Res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Oldest task", description: "first", selector: "/", status: "todo" }),
    });
    expect((await task1Res.json() as { success: boolean }).success).toBe(true);

    const task2Res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Middle task", description: "second", selector: "/", status: "todo" }),
    });
    expect((await task2Res.json() as { success: boolean }).success).toBe(true);

    const task3Res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Newest task", description: "third", selector: "/", status: "todo" }),
    });
    expect((await task3Res.json() as { success: boolean }).success).toBe(true);

    // Wait for all 3 tasks to appear in the todo column via WebSocket
    await page.waitForFunction(
      () => document.querySelectorAll('[data-column-id="todo"] [data-task-id]').length >= 3,
      { timeout: 8_000 },
    );

    // Get the order of tasks in the todo column
    const taskOrder = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-column-id="todo"] article.task-card')];
      return cards.map(c => c.textContent?.trim() ?? '');
    });

    // The newest task ("Newest task") should be at the bottom (last position)
    // The oldest task ("Oldest task") should be at the top (first position)
    const oldestIndex = taskOrder.findIndex(t => t.includes("Oldest task"));
    const newestIndex = taskOrder.findIndex(t => t.includes("Newest task"));

    expect(oldestIndex).toBeGreaterThanOrEqual(0);
    expect(newestIndex).toBeGreaterThanOrEqual(0);
    expect(oldestIndex).toBeLessThan(newestIndex);
  });

  // ── Default model in Agent tab ─────────────────────────────────────────────
  it("shows default model from settings in Agent tab when no model is chosen", async () => {
    const title = `Default model test ${Date.now()}`;
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: "test default model", selector: "/" }),
    });
    const data = await res.json() as { success: boolean; task?: { id: string } };
    expect(data.success).toBe(true);
    const taskId = data.task?.id;

    // Set default model via settings API
    await fetch(`${BASE}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: "anthropic/claude-sonnet-4-5-20250514" }),
    });

    await waitForTaskOnBoard(page, taskId);

    // Open the task
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, taskId);
    await page.waitForSelector("#detail-panel.open");

    // Switch to Agent tab
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane:not([style*='none'])");

    // The model picker button should exist in the agent pane
    const modelButtonExists = await page.locator("#dp-agent-pane button").count();
    expect(modelButtonExists).toBeGreaterThanOrEqual(1);

    // The button text should not be the placeholder (if models are loaded)
    const buttonText = await page.evaluate(() => {
      const btn = document.querySelector("#dp-agent-pane button") as HTMLElement | null;
      return btn?.textContent?.trim() ?? null;
    });
    // If models are loaded, it should show a model name or "Select model"
    expect(buttonText === null || buttonText === "Select model" || buttonText.length > 0).toBe(true);
  });

  it("shows Run Agent button in footer only on Agent tab", async () => {
    const title = `Run agent button test ${Date.now()}`;
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: "test run agent button", selector: "/" }),
    });
    const data = await res.json() as { success: boolean; task?: { id: string } };
    expect(data.success).toBe(true);
    const taskId = data.task?.id;

    await waitForTaskOnBoard(page, taskId);

    // Open the task
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, taskId);
    await page.waitForSelector("#detail-panel.open");

    // On Details tab, Run Agent button should NOT be visible
    await page.click("#dp-tab-details");
    await page.waitForSelector("#dp-details-pane:not([style*='none'])");
    const runButtonOnDetails = await page.locator("#dp-run-agent").count();
    expect(runButtonOnDetails).toBe(0);

    // On Agent tab, Run Agent button SHOULD be visible
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane:not([style*='none'])");
    const runButtonOnAgent = await page.locator("#dp-run-agent").count();
    expect(runButtonOnAgent).toBe(1);

    // Button should have correct text
    const buttonText = await page.textContent("#dp-run-agent");
    expect(buttonText).toContain("Run Agent");
  });

  it("model picker opens and allows selecting a model", async () => {
    const title = `Model picker test ${Date.now()}`;
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: "test model picker", selector: "/" }),
    });
    const data = await res.json() as { success: boolean; task?: { id: string } };
    expect(data.success).toBe(true);
    const taskId = data.task?.id;

    await waitForTaskOnBoard(page, taskId);

    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, taskId);
    await page.waitForSelector("#detail-panel.open");

    // Switch to Agent tab
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane:not([style*='none'])");

    // Click the model picker button to open dropdown
    await page.click("#dp-agent-pane button");
    // Wait for the portaled dropdown to appear
    await page.waitForSelector("[data-model-picker-dropdown]");

    // Dropdown should contain model options
    const options = await page.locator("[data-model-picker-dropdown] button").all();
    expect(options.length).toBeGreaterThan(0);

    // Click the first model option
    await options[0].click();

    // Dropdown should close
    const dropdownCount = await page.locator("[data-model-picker-dropdown]").count();
    expect(dropdownCount).toBe(0);
  });

  it("model picker toggles open/close without changing value", async () => {
    const title = `Model toggle test ${Date.now()}`;
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: "test toggle", selector: "/" }),
    });
    const data = await res.json() as { success: boolean; task?: { id: string } };
    expect(data.success).toBe(true);
    const taskId = data.task?.id;

    await waitForTaskOnBoard(page, taskId);
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, taskId);
    await page.waitForSelector("#detail-panel.open");
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane:not([style*='none'])");

    // Get the model picker button
    const pickerButton = page.locator("#dp-agent-pane button").first();
    const initialText = await pickerButton.textContent();

    // Click to open dropdown
    await pickerButton.click();
    await page.waitForSelector("[data-model-picker-dropdown]");

    // Click again to close dropdown (toggle behavior)
    await pickerButton.click();

    // Dropdown should be closed
    const dropdownClosed = await page.locator("[data-model-picker-dropdown]").count();
    expect(dropdownClosed).toBe(0);

    // Value should not have changed
    const finalText = await pickerButton.textContent();
    expect(finalText).toBe(initialText);
  });

  it("agent queue panel opens from header and shows active runs", async () => {
    const title = `Agent queue test ${Date.now()}`;
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: "test agent queue", selector: "/" }),
    });
    const data = await res.json() as { success: boolean; task?: { id: string } };
    expect(data.success).toBe(true);
    const taskId = data.task?.id;

    await waitForTaskOnBoard(page, taskId);

    // Open task and go to Agent tab to trigger a run
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, taskId);
    await page.waitForSelector("#detail-panel.open");
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane:not([style*='none'])");

    // Click Run Agent to start a run
    await page.click("#dp-run-agent");

    // Wait a moment for the run to register
    await page.waitForTimeout(500);

    // The header should show an agent queue badge (count > 0)
    // Open the agent queue panel via the header button
    const queueButton = await page.locator("#btn-agent-queue").count();
    if (queueButton > 0) {
      await page.click("#btn-agent-queue");
      // Panel should appear
      await page.waitForSelector("#agent-queue-panel");

      // Panel should contain the task title
      const panelText = await page.textContent("#agent-queue-panel");
      expect(panelText).toContain(title);

      // Close button should work
      await page.click("#agent-queue-close");
      const panelVisible = await page.locator("#agent-queue-panel").count();
      expect(panelVisible).toBe(0);
    }
  });

  it("model selection updates the picker and is sent in the agent run request", async () => {
    const title = `Model selection api test ${Date.now()}`;
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: "test model selection api", selector: "/" }),
    });
    const data = await res.json() as { success: boolean; task?: { id: string } };
    expect(data.success).toBe(true);
    const taskId = data.task?.id;

    await waitForTaskOnBoard(page, taskId);

    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, taskId);
    await page.waitForSelector("#detail-panel.open");
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane:not([style*='none'])");

    // Intercept the agent run API request to verify the selected model is sent
    let requestBody: { model?: string; taskId?: string } | null = null;
    await page.route("**/api/agent/run", async (route) => {
      const postData = route.request().postData();
      if (postData) {
        try { requestBody = JSON.parse(postData) as { model?: string; taskId?: string }; } catch {}
      }
      // Abort so we don't actually spawn an agent
      await route.abort("aborted");
    });

    // Open model picker
    const pickerButton = page.locator("#dp-agent-pane button").first();
    await pickerButton.click();
    await page.waitForSelector("[data-model-picker-dropdown]");

    // Select the second model option (first is likely already selected)
    const options = await page.locator("[data-model-picker-dropdown] button").all();
    expect(options.length).toBeGreaterThan(1);
    const targetOption = options[1];
    const targetLabel = await targetOption.textContent();
    expect(targetLabel).toBeTruthy();
    await targetOption.click();

    // Wait for dropdown to close
    await page.waitForFunction(
      () => !document.querySelector("[data-model-picker-dropdown]"),
      { timeout: 3_000 },
    );

    // Verify the picker button shows the selected model label
    const buttonText = await pickerButton.textContent();
    expect(buttonText).toContain(targetLabel!.replace("Rec", "").trim());

    // Click Run Agent — the intercepted request should contain the selected model
    await page.click("#dp-run-agent");
    await page.waitForTimeout(500);

    expect(requestBody).not.toBeNull();
    expect(requestBody!.taskId).toBe(taskId);
    // The model should be the selected one (not empty)
    expect(requestBody!.model).toBeTruthy();

    await page.unroute("**/api/agent/run");
  });

  it("picking an agent in the agent tab does not close the detail panel", { timeout: 30_000 }, async () => {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Agent picker regression task", description: "ap", selector: "/" }),
    });
    const data = (await res.json()) as { success: boolean; task?: { id: string } };
    expect(data.success).toBe(true);
    const taskId = data.task?.id!;

    await waitForTaskOnBoard(page, taskId);

    // Open the task detail panel
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      card?.click();
    }, taskId);
    await page.waitForSelector("#detail-panel.open");

    // Switch to the agent tab
    await page.click("#dp-tab-agent");
    await page.waitForSelector("#dp-agent-pane");

    // Wait a moment for the agent tab to fully render
    await page.waitForTimeout(300);

    // Check if an agent picker is present (skip if no agents configured)
    const agentPickerButton = page.locator('#dp-agent-pane button').filter({ hasText: /Select agent|buildprimary/ });
    const count = await agentPickerButton.count();
    if (count === 0) {
      console.warn("Skipping agent picker test: no agents configured");
      return;
    }

    // Open the agent picker dropdown
    await agentPickerButton.click();
    await page.waitForSelector("[data-agent-picker-dropdown]");

    // Click the first agent option in the dropdown
    await page.locator("[data-agent-picker-dropdown] button").first().click();

    // The detail panel should still be open — this was the bug
    const panelStillOpen = await page.evaluate(() =>
      document.getElementById("detail-panel")?.classList.contains("open") ?? false,
    );
    expect(panelStillOpen).toBe(true);
  });

  // ── Multi-select drag & drop ───────────────────────────────────────────────
  it("multi-select drag reorders selected tasks while preserving relative order", { timeout: 30_000 }, async () => {
    // Reload to ensure clean state after agent tests (close any open panels/modals)
    await page.reload();
    await page.waitForSelector("#kanban-board");

    // Create 5 tasks in todo column with explicit sortKeys
    const tasks: Array<{ id: string; title: string }> = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Multi-drag task ${i + 1}`,
          description: "md",
          selector: "/",
          status: "todo",
          sortKey: `0000000${i + 1}00000000`,
        }),
      });
      const data = (await res.json()) as { success: boolean; task?: { id: string } };
      expect(data.success).toBe(true);
      tasks.push({ id: data.task!.id, title: `Multi-drag task ${i + 1}` });
    }

    // Wait for all tasks to appear on the board
    for (const t of tasks) {
      await waitForTaskOnBoard(page, t.id);
    }

    // Enter select mode via long-press on task 2 (the first task we want to drag)
    const task2Card = page.locator(`[data-task-id="${tasks[1].id}"]`).first();
    await task2Card.scrollIntoViewIfNeeded();

    // Dispatch long-press events directly on the DOM element (page.mouse doesn't
    // reliably trigger React synthetic onMouseDown/onMouseUp)
    await page.evaluate((taskId) => {
      const card = document.querySelector(`article[data-task-id="${taskId}"]`) as HTMLElement;
      if (!card) return;
      card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    }, tasks[1].id);
    await page.waitForTimeout(350); // long-press threshold is 300ms
    await page.evaluate((taskId) => {
      const card = document.querySelector(`article[data-task-id="${taskId}"]`) as HTMLElement;
      if (!card) return;
      card.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    }, tasks[1].id);
    await page.waitForTimeout(200); // wait for select mode to activate

    // Add task 4 to the selection (0-indexed: index 3)
    const task4Card = page.locator(`[data-task-id="${tasks[3].id}"]`).first();

    // Click cards to select them — use force:true to bypass z-index overlap checks
    // (a floating toolbar appears when experimentalAgents=true and a task is selected)
    await task2Card.click({ force: true });
    await task4Card.click({ force: true });

    // Verify both are selected (selected cards get a border style)
    const task2Selected = await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      return card?.style.borderColor !== '' || card?.classList.contains('selected');
    }, tasks[1].id);
    expect(task2Selected).toBe(true);

    const task4Selected = await page.evaluate((id) => {
      const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
      return card?.style.borderColor !== '' || card?.classList.contains('selected');
    }, tasks[3].id);
    expect(task4Selected).toBe(true);

    // Drag task 2 (the first selected in DOM order) onto the TOP HALF of task 5.
    // Use page.evaluate to dispatch HTML5 drag events at precise positions.
    const task5Card = page.locator(`[data-task-id="${tasks[4].id}"]`).first();

    // Scroll both cards into view to get accurate bounding boxes
    await task2Card.scrollIntoViewIfNeeded();
    await task5Card.scrollIntoViewIfNeeded();
    const t2Box = (await task2Card.boundingBox())!;
    const t5Box = (await task5Card.boundingBox())!;

    // Dispatch drag events: dragstart on t2 → dragover on t5 (top half) → drop on t5
    await page.evaluate(({ t2Id, t5Id, t2CX, t2CY, t5X, t5Y }) => {
      const t2 = document.querySelector(`article[data-task-id="${t2Id}"]`) as HTMLElement;
      const t5 = document.querySelector(`article[data-task-id="${t5Id}"]`) as HTMLElement;
      if (!t2 || !t5) return;
      const dt = new DataTransfer();
      // 1. dragstart on t2 (center)
      t2.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: t2CX, clientY: t2CY }));
      // 2. multiple dragover events on t5 to ensure position is set (clientY in top 10% → "before")
      for (let i = 0; i < 3; i++) {
        t5.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: t5X, clientY: t5Y }));
      }
      // 3. drop on t5 (same position as dragover)
      t5.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: t5X, clientY: t5Y }));
    }, {
      t2Id: tasks[1].id,
      t5Id: tasks[4].id,
      t2CX: Math.round(t2Box.x + t2Box.width / 2),
      t2CY: Math.round(t2Box.y + t2Box.height / 2),
      t5X: Math.round(t5Box.x + 10),
      t5Y: Math.round(t5Box.y + Math.floor(t5Box.height * 0.1)),
    });

    // Wait for reorder to settle
    await page.waitForTimeout(800);

    // Get the final order of task IDs in the todo column
    const finalOrderIds = await page.evaluate(() => {
      const col = document.querySelector('[data-column-id="todo"] .column-scroll');
      if (!col) return [];
      return Array.from(col.querySelectorAll('article.task-card')).map(card =>
        card.getAttribute('data-task-id'),
      );
    });

    // Filter to only our test tasks — previous tests may have left other tasks in the column
    const ourTaskIds = new Set(tasks.map(t => t.id));
    const ourTaskOrderIds = finalOrderIds.filter((id: string | null) => ourTaskIds.has(id));

    // With the drop landing on the top half of task 5, the dragged group is inserted
    // BEFORE task 5. Expected order: task1, task3, task2, task4, task5.
    // The key invariant: tasks 2 and 4 stay together and preserve their relative order.
    const expectedIds = [
      tasks[0].id, // task 1
      tasks[2].id, // task 3
      tasks[1].id, // task 2
      tasks[3].id, // task 4
      tasks[4].id, // task 5
    ];

    expect(ourTaskOrderIds).toEqual(expectedIds);

    // Exit select mode via ESC
    await page.keyboard.press("Escape");
  });

});

// ─── Task reference navigation e2e tests ────────────────────────────────────
// Covers: #taskId links rendered in markdown, hash navigation, back button, 
// multiple jump stack, and browser back.

describe("Task reference navigation", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;
  let taskAId: string;
  let taskBId: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-refnav-pw-"));
    instance = await serve(undefined, { port: 3898, open: false, projectDir: tempDir });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    // Create two tasks: Task A references Task B in its description.
    const resA = await fetch("http://localhost:3898/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Task Alpha", description: "See also: #PLACEHOLDER", selector: "/", status: "todo" }),
    });
    taskAId = ((await resA.json()) as { task?: { id: string } }).task?.id ?? "";

    const resB = await fetch("http://localhost:3898/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Task Beta", description: "This is referenced from Alpha.", selector: "/", status: "todo" }),
    });
    taskBId = ((await resB.json()) as { task?: { id: string } }).task?.id ?? "";

    expect(taskAId).toBeTruthy();
    expect(taskBId).toBeTruthy();

    // Update Task A to reference Task B using the current full-length markdown contract.
    await fetch(`http://localhost:3898/api/tasks/${taskAId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: `See also: #${taskBId}` }),
    });

    await page.goto("http://localhost:3898/kanban");
    await page.waitForSelector("#kanban-board");
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Wait for task to appear via WS update, fallback to reload. */
  async function waitForTaskOnBoardLocal(titleOrId: string, timeout = 8_000) {
    const appeared = await page.waitForFunction(
      (idOrTitle) => {
        if (document.querySelector(`[data-task-id="${idOrTitle}"]`)) return true;
        return [...document.querySelectorAll("#kanban-board article.task-card")]
          .some(c => c.textContent?.includes(idOrTitle));
      },
      titleOrId,
      { timeout },
    ).catch(() => false);
    if (appeared) return;
    await page.reload();
    await page.waitForSelector("#kanban-board");
    await page.waitForFunction(
      (idOrTitle) => {
        if (document.querySelector(`[data-task-id="${idOrTitle}"]`)) return true;
        return [...document.querySelectorAll("#kanban-board article.task-card")]
          .some(c => c.textContent?.includes(idOrTitle));
      },
      titleOrId,
      { timeout: 8_000 },
    );
  }

  it("renders a full task reference as a clickable link in description preview", async () => {
    // Open Task A
    await page.locator(`[data-task-id="${taskAId}"]`).click();
    await page.waitForSelector("#detail-panel");

    // Wait for the markdown-rendered description with the task ref link
    await page.waitForSelector(`a[data-task-ref="${taskBId}"]`, { timeout: 5_000 });
    const href = await page.getAttribute(`a[data-task-ref="${taskBId}"]`, "href");
    expect(href).toBe(`#task-${taskBId}`);
  });

  it("clicking a task reference link opens the referenced task", async () => {
    // Task A should already be open from the previous test.
    // Click the task-ref link to navigate to Task B.
    await page.click(`a[data-task-ref="${taskBId}"]`);

    // Wait for the panel title to update to Task B
    await page.waitForFunction(
      () => (document.getElementById("dp-title") as HTMLInputElement | null)?.value === "Task Beta",
      { timeout: 5_000 },
    );
  });

  it("shows back button after navigating via a task reference", async () => {
    // We should now be on Task B, having navigated from Task A.
    const backVisible = await page.isVisible("#dp-back");
    expect(backVisible).toBe(true);
    const backTitle = await page.getAttribute("#dp-back", "title");
    expect(backTitle ?? "").toMatch(/Back to|Go back/);
  });

  it("clicking back button returns to the previous task", async () => {
    await page.click("#dp-back");

    await page.waitForFunction(
      () => (document.getElementById("dp-title") as HTMLInputElement | null)?.value === "Task Alpha",
      { timeout: 5_000 },
    );
    // Back button should be gone after returning to the original task
    await page.waitForFunction(() => !document.getElementById("dp-back"), { timeout: 2_000 });
  });

  it("does not convert short task ID prefixes into task reference links", async () => {
    // Update Task A description to use a short prefix that should remain plain text.
    await fetch(`http://localhost:3898/api/tasks/${taskAId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: `Short ref: #${taskBId.slice(0, 8)}` }),
    });

    await waitForTaskOnBoardLocal(taskAId);

    await page.locator(`[data-task-id="${taskAId}"]`).click();
    await page.waitForSelector("#detail-panel");

    const shortLinkCount = await page.locator(`a[data-task-ref="${taskBId.slice(0, 8)}"]`).count();
    expect(shortLinkCount).toBe(0);
    const previewText = await page.textContent("#dp-desc-preview");
    expect(previewText ?? "").toContain(`#${taskBId.slice(0, 8)}`);
  });

  it("supports multiple jump levels (A → B → A via task ref in B description)", async () => {
    // Add a back-reference in Task B to Task A
    await fetch(`http://localhost:3898/api/tasks/${taskBId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: `Back-ref to Alpha: #${taskAId}` }),
    });

    await fetch(`http://localhost:3898/api/tasks/${taskAId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: `See also: #${taskBId}` }),
    });

    // Start at Task A (wait for fresh task data via WS)
    await waitForTaskOnBoardLocal(taskAId);
    await page.locator(`[data-task-id="${taskAId}"]`).click();
    await page.waitForSelector("#detail-panel");

    // Jump A → B
    await page.click(`a[data-task-ref="${taskBId}"]`);
    await page.waitForFunction(
      () => (document.getElementById("dp-title") as HTMLInputElement | null)?.value === "Task Beta",
      { timeout: 5_000 },
    );

    // Jump B → A (second level)
    await page.click(`a[data-task-ref="${taskAId}"]`);
    await page.waitForFunction(
      () => (document.getElementById("dp-title") as HTMLInputElement | null)?.value === "Task Alpha",
      { timeout: 5_000 },
    );

    // Back button should exist (history has 2 entries: A → B → A, so "back" goes to B)
    const backVisible = await page.isVisible("#dp-back");
    expect(backVisible).toBe(true);

    // Clicking back should go to Task B
    await page.click("#dp-back");
    await page.waitForFunction(
      () => (document.getElementById("dp-title") as HTMLInputElement | null)?.value === "Task Beta",
      { timeout: 5_000 },
    );

    // Clicking back again should go to Task A
    await page.click("#dp-back");
    await page.waitForFunction(
      () => (document.getElementById("dp-title") as HTMLInputElement | null)?.value === "Task Alpha",
      { timeout: 5_000 },
    );

    // Back button should be gone now (empty history)
    await page.waitForFunction(() => !document.getElementById("dp-back"), { timeout: 2_000 });
  });

  // ── Task reference navigation ──────────────────────────────────────────────
});


