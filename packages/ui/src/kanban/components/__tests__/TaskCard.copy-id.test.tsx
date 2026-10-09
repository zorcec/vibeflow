import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TaskCard } from "../TaskCard";
import type { Task, Column } from "../../types";

const col: Column = {
  id: "todo",
  label: "Todo",
  color: "#f59e0b",
  accent: "#f59e0b",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-under-test",
    title: "Copy me",
    status: "todo",
    ...overrides,
  };
}

function renderCard(task: Task, extra: object = {}) {
  return render(
    <TaskCard
      task={task}
      col={col}
      allTasks={[task]}
      onOpen={vi.fn()}
      onDragStart={vi.fn()}
      {...extra}
    />,
  );
}

describe("TaskCard copy-id button", () => {
  let writeText: ReturnType<typeof vi.fn>;
  let execCommand: ReturnType<typeof vi.fn>;
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand as unknown as typeof document.execCommand;
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("renders with a stable test hook titled with the task id", () => {
    const { container } = renderCard(makeTask());
    const btn = container.querySelector('[data-role="copy-id"]');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute(
      "title",
      expect.stringContaining("task-under-test"),
    );
  });

  it("copies the task id to the clipboard on click", async () => {
    const { container } = renderCard(makeTask());
    fireEvent.click(container.querySelector('[data-role="copy-id"]')!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("task-under-test"));
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("does not open the detail panel when the copy button is clicked", async () => {
    const onOpen = vi.fn();
    const { container } = renderCard(makeTask(), { onOpen });
    fireEvent.click(container.querySelector('[data-role="copy-id"]')!);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("swaps to the check icon as copy feedback, then reverts", async () => {
    vi.useFakeTimers();
    const { container } = renderCard(makeTask());
    const btn = container.querySelector('[data-role="copy-id"]')!;
    // The lucide Copy glyph renders with the lucide class naming convention.
    expect(btn.querySelector(".lucide-copy")).toBeInTheDocument();

    fireEvent.click(btn);
    await vi.waitFor(() =>
      expect(btn.querySelector(".lucide-check")).toBeInTheDocument(),
    );

    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(btn.querySelector(".lucide-check")).not.toBeInTheDocument();
    expect(btn.querySelector(".lucide-copy")).toBeInTheDocument();
  });

  it("falls back to execCommand when clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const { container } = renderCard(makeTask());
    const appendSpy = vi.spyOn(document.body, "appendChild");
    fireEvent.click(container.querySelector('[data-role="copy-id"]')!);
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(appendSpy).toHaveBeenCalled();
  });

  it("renders in the compact/done single-row variant too", () => {
    const { container } = renderCard(makeTask(), { compact: true });
    expect(container.querySelector('[data-role="copy-id"]')).toBeInTheDocument();
    const { container: doneContainer } = renderCard(
      makeTask({ status: "done" }),
    );
    expect(
      doneContainer.querySelector('[data-role="copy-id"]'),
    ).toBeInTheDocument();
  });
});
