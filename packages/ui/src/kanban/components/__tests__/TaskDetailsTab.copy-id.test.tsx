// @vitest-environment jsdom
/**
 * Ticket ecb9d938 — the details ID tile (`#dp-id`) must carry a copy-id
 * affordance, always visible, that strengthens on hover.
 *
 * The tile reuses the shared CopyIdButton in pill mode (no `edge`), so it
 * keeps the existing clipboard + `data-copied` feedback and fallbacks. Pill
 * mode is `opacity: 0` at rest through `.card-copy-id`, so the tile passes an
 * inline `opacity: 1` to keep it visible here WITHOUT weakening that shared
 * rule for every other pill.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TaskDetailsTab } from "../shared/TaskDetailsTab";
import type { Task } from "../../types";

const TASK_ID = "ecb9d938-copy-id-task";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Details copy-id task",
    status: "todo",
    type: "Task",
    priority: null,
    description: "",
    tags: [],
    comments: [],
    files: [],
    links: [],
    createdAt: new Date("2026-10-06T00:00:00Z"),
    ...overrides,
  } as unknown as Task;
}

function renderTab() {
  return render(
    <TaskDetailsTab
      task={makeTask()}
      description=""
      setDescription={vi.fn()}
      showDescPreview={false}
      setShowDescPreview={vi.fn()}
      priority=""
      setPriority={vi.fn()}
      onFilePreview={vi.fn()}
      onDeleteScreenshot={vi.fn()}
      onPatch={vi.fn()}
    />,
  );
}

describe("TaskDetailsTab id tile", () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("renders the copy-id control in #dp-id, always visible, with the id in its title", () => {
    // Non-vacuity: this test fails on the pre-change component — no
    // `[data-role="copy-id"]` exists inside `#dp-id` at all, so the
    // `not.toBeNull()` guard reds first. If the inline `opacity: 1` is
    // removed (or the control is switched to collapsed edge mode) the pill
    // renders with inline opacity "" / "0", reding the `.toBe("1")` below —
    // proved by temporarily dropping the style prop.
    renderTab();
    const tile = document.querySelector("#dp-id");
    expect(tile).not.toBeNull();
    // The id text stays inside the tile alongside the control.
    expect(tile!.textContent).toContain(TASK_ID);

    const btn = tile!.querySelector(
      '[data-role="copy-id"]',
    ) as HTMLElement | null;
    expect(btn).not.toBeNull();
    // Always visible at rest: inline opacity 1 beats the shared
    // `.card-copy-id { opacity: 0 }` resting rule.
    expect(btn!.style.opacity).toBe("1");
    // Quiet affordance, not hidden: a real button in the a11y tree.
    expect(btn).toHaveAccessibleName("Copy task id");
    expect(btn).toHaveAttribute("title", expect.stringContaining(TASK_ID));
    // Hover styling is the stylesheet's `.card-copy-id:hover` (background
    // --t-hover + colour --t-text); the resting colour is the quiet
    // `.card-copy-id` --t-border-faint, so hover is strictly stronger. The
    // class that opts into those shared rules must be present.
    expect(btn).toHaveClass("card-copy-id");
    // Ticket 2e6b6b1f: the 16px cap that keeps this pill from outgrowing
    // the value line keys on this modifier class. If the class is renamed
    // or dropped, the stylesheet rule silently detaches and the ID row
    // grows back to 22px — so the hook itself is pinned here (the box
    // values live in the geometry-contract CSS test, jsdom applies no
    // stylesheet).
    expect(btn).toHaveClass("card-copy-id--detail");
  });

  it("copies the task id and flips to the copied state on click", () => {
    renderTab();
    const btn = document.querySelector(
      '#dp-id [data-role="copy-id"]',
    ) as HTMLElement;
    expect(btn).not.toHaveAttribute("data-copied");

    fireEvent.click(btn);
    return waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(TASK_ID),
    ).then(() => waitFor(() => expect(btn).toHaveAttribute("data-copied", "true")));
  });
});
