// @vitest-environment jsdom
/**
 * DetailPanel title autofocus — the focus-stealing regression guard.
 *
 * The panel focused its title input from a bare `setTimeout(…, 50)` inside an
 * effect keyed on `[open, task?.id, tab]`. That fired on every task switch AND
 * every tab switch, unconditionally, so anything that had taken focus inside
 * the panel in the meantime lost it 50ms later.
 *
 * Two concrete failures came out of it:
 *   1. A user who opened a task and clicked the Tags input had focus yanked
 *      back to the title mid-click.
 *   2. Worse, whatever was typing then delivered its characters to the title:
 *      in the web e2e suite this renamed real rows from "Tag Test Task" to
 *      "Tag Test Taskmy-new-tag" roughly one run in three, and persisted it.
 *
 * These tests pin the corrected contract: the autofocus still happens when the
 * panel opens (that is the feature), but it never steals focus from a control
 * that already holds it.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";
import type { Task } from "../../types";

vi.useRealTimers();

const task: Task = {
  id: "t1",
  title: "Tag Test Task",
  status: "todo",
  type: "Task",
  priority: null,
  description: "",
  tags: [],
  comments: [],
  files: [],
  links: [],
  createdAt: new Date("2026-01-01T00:00:00Z"),
} as unknown as Task;

function baseProps(
  tab: React.ComponentProps<typeof DetailPanel>["tab"],
): React.ComponentProps<typeof DetailPanel> {
  return {
    open: true,
    task,
    tab,
    baseUrl: "http://localhost:3700",
    api: {
      loadComments: vi.fn().mockResolvedValue([]),
      loadFiles: vi.fn().mockResolvedValue([]),
      loadBadgeCounts: vi.fn().mockResolvedValue({ comments: 0, files: 0 }),
    } as unknown as React.ComponentProps<typeof DetailPanel>["api"],
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    onPatch: vi.fn(),
    onFilePreview: vi.fn(),
  };
}

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof DetailPanel>> = {},
) {
  return render(<DetailPanel {...baseProps("details")} {...overrides} />);
}

/** Let the 50ms autofocus timer fire. */
function advanceAutofocus() {
  vi.advanceTimersByTime(80);
}

describe("DetailPanel title autofocus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("focuses the title when the panel opens and nothing else has focus", () => {
    // Focus starts on <body>, which is what a real "panel just opened" looks
    // like — the autofocus is the feature under test, so it must still fire.
    (document.activeElement as HTMLElement | null)?.blur?.();
    renderPanel();
    advanceAutofocus();

    expect(document.activeElement).toBe(screen.getByPlaceholderText("Task title…"));
  });

  it("does NOT steal focus from a control the user already focused", () => {
    renderPanel();

    // The user (or an IME, an autofill, a test driver) reaches the Tags input
    // before the 50ms timer lands.
    const tagInput = document.querySelector<HTMLInputElement>(
      ".dp-meta-label + div input[type='text']",
    );
    expect(tagInput).not.toBeNull();
    tagInput!.focus();
    expect(document.activeElement).toBe(tagInput);

    advanceAutofocus();

    // Focus must still be in the tags input — this is the exact condition
    // under which the title used to swallow the typed characters.
    expect(document.activeElement).toBe(tagInput);
  });

  it("still autofocuses when focus sits outside the panel (e.g. on body after a click elsewhere)", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    renderPanel();
    advanceAutofocus();

    expect(document.activeElement).toBe(screen.getByPlaceholderText("Task title…"));
    outside.remove();
  });

  it("re-running the effect (tab switch) does not yank focus away either", () => {
    const { rerender } = renderPanel();
    advanceAutofocus();

    const tagInput = document.querySelector<HTMLInputElement>(
      ".dp-meta-label + div input[type='text']",
    )!;
    tagInput.focus();

    // Switching tabs re-runs the [open, task?.id, tab] effect.
    rerender(<DetailPanel {...baseProps("comments")} />);
    advanceAutofocus();

    expect(document.activeElement).toBe(tagInput);
  });

  it("typing after opening never lands in the title once another control holds focus", () => {
    renderPanel();
    advanceAutofocus();

    const tagInput = document.querySelector<HTMLInputElement>(
      ".dp-meta-label + div input[type='text']",
    )!;
    fireEvent.focus(tagInput);
    fireEvent.change(tagInput, { target: { value: "my-new-tag" } });
    advanceAutofocus();

    const title = screen.getByPlaceholderText("Task title…") as HTMLInputElement;
    expect(title.value).toBe("Tag Test Task");
    expect(tagInput.value).toBe("my-new-tag");
  });
});
