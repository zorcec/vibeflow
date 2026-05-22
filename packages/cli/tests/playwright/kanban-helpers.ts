/**
 * Shared helpers for Kanban Playwright tests.
 * Extracted to avoid duplication across split test files.
 */
import type { Page } from "playwright";

export async function openAddTask(page: Page, columnId: string) {
  await page.click(`[data-column-id='${columnId}'] button[title^='Add task']`);
  await page.waitForSelector("#detail-panel.open");
}

export async function openTaskByTitle(page: Page, title: string) {
  await page.evaluate((taskTitle) => {
    const card = [...document.querySelectorAll("#kanban-board article.task-card")]
      .find((candidate) => candidate.textContent?.includes(taskTitle)) as HTMLElement | undefined;
    card?.click();
  }, title);
  await page.waitForSelector("#detail-panel.open");
}

export async function openActivityTab(page: Page) {
  await page.click("#dp-tab-activity");
  await page.waitForSelector("#dp-activity-pane:not([style*='none'])");
}

export async function openFilesTab(page: Page) {
  await page.click("#dp-tab-files");
  await page.waitForSelector("#dp-files-pane:not([style*='none'])");
}

export async function focusDescriptionEditor(page: Page) {
  const hasTextarea = await page.locator("#dp-desc").count();
  if (hasTextarea > 0) return;
  await page.click("#dp-desc-preview");
  await page.waitForSelector("#dp-desc", { timeout: 5_000 });
}

export async function closePanelIfOpen(page: Page) {
  const closeCount = await page.locator("#dp-close").count();
  if (closeCount === 0) return;
  await page.click("#dp-close");
  await page.waitForFunction(() => !document.getElementById("detail-panel"), { timeout: 5_000 }).catch(() => {});
}

/**
 * Wait for a task to appear on the kanban board via WebSocket live update.
 * Falls back to page.reload() if the task doesn't appear within timeout.
 */
export async function waitForTaskOnBoard(page: Page, titleOrId: string, timeout = 8_000) {
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

  // Fallback: reload if WS didn't deliver
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
