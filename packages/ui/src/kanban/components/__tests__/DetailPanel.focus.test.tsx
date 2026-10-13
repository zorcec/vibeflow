// @vitest-environment jsdom
/**
 * New-task title autofocus (2abcec19).
 *
 * When the new-task panel opens, focus must land in the title input so typing
 * starts the task name immediately. The description editor must NOT steal it:
 * its mount autofocus used to win the race (it fires before the title's
 * deferred focus, which then backs off seeing focus already in-panel), so
 * typing landed in the description instead.
 *
 * Also locks the existing-task contract: title takes initial focus on open,
 * but a later panel re-open (tab switch) must not steal focus from an
 * in-panel control the user is editing.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";
import type { Task } from "../../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "30-hex-task-id-0000000000",
    title: "Focus task",
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

function apiStub() {
  return {
    loadComments: vi.fn().mockResolvedValue([]),
    loadFiles: vi.fn().mockResolvedValue([]),
    loadBadgeCounts: vi.fn().mockResolvedValue({ comments: 0, files: 0 }),
  } as unknown as React.ComponentProps<typeof DetailPanel>["api"];
}

function renderPanel(props: Partial<React.ComponentProps<typeof DetailPanel>>) {
  return render(
    <DetailPanel
      open
      task={null}
      tab="details"
      baseUrl="http://localhost:3700"
      api={apiStub()}
      onClose={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onPatch={vi.fn()}
      onFilePreview={vi.fn()}
      {...props}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DetailPanel new-task title autofocus", () => {
  it("focuses #dp-title (not #dp-desc) when the new-task panel opens", () => {
    vi.useFakeTimers();
    renderPanel({ task: null });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.querySelector("#dp-title")).not.toBeNull();
    expect(document.activeElement?.id).toBe("dp-title");
  });

  it("focuses #dp-title when an existing task panel opens", () => {
    vi.useFakeTimers();
    renderPanel({ task: makeTask() });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.activeElement?.id).toBe("dp-title");
  });

  it("does not steal focus from an in-panel control on re-open", () => {
    vi.useFakeTimers();
    const utils = renderPanel({ task: makeTask(), tab: "details" });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.activeElement?.id).toBe("dp-title");
    // Owner moves into the priority select, then the panel re-opens
    // (tab switch re-runs the focus effect).
    const priority = document.querySelector(
      "#dp-priority",
    ) as HTMLElement | null;
    expect(priority).not.toBeNull();
    act(() => {
      priority!.focus();
    });
    expect(document.activeElement?.id).toBe("dp-priority");
    utils.rerender(
      <DetailPanel
        open
        task={makeTask()}
        tab="files"
        baseUrl="http://localhost:3700"
        api={apiStub()}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onPatch={vi.fn()}
        onFilePreview={vi.fn()}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.activeElement?.id).toBe("dp-priority");
  });
});
