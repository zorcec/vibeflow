// @vitest-environment jsdom
/**
 * "+N more" landing: the board's children popover truncates at 30 rows and its
 * affordance opens the task through the normal path, then asks the fresh panel
 * to land on the full children list at the bottom of the details pane.
 *
 * Two arrivals, one intent:
 * 1. Pending flag — the panel was closed and mounts on open; the open effect
 *    consumes it and scrolls `#dp-details-pane` to its bottom.
 * 2. Event — the panel is already open on the same task (the open effect will
 *    not rerun for the same id); the panel scrolls on the event.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";
import {
  requestRelationsScroll,
  consumeRelationsScroll,
  relationsScrollEvent,
} from "../detail-panel-scroll";
import type { Task } from "../../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "parent-0001-task-id",
    title: "Parent task",
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
    getComments: vi.fn().mockResolvedValue({ comments: [] }),
    getFiles: vi.fn().mockResolvedValue({ files: [] }),
  } as unknown as React.ComponentProps<typeof DetailPanel>["api"];
}

function renderPanel(task: Task) {
  return render(
    <DetailPanel
      open
      task={task}
      tab="details"
      baseUrl="http://localhost:3700"
      api={apiStub()}
      onClose={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onPatch={vi.fn()}
      onFilePreview={vi.fn()}
    />,
  );
}

function pane(): HTMLElement {
  const el = document.querySelector("#dp-details-pane") as HTMLElement | null;
  if (!el) throw new Error("details pane did not render");
  return el;
}

/** jsdom has no layout (scrollHeight is 0): pin a fake content height. */
function pinContentHeight(el: HTMLElement, px: number) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: px,
  });
}

const flushRaf = () => new Promise((r) => setTimeout(r, 50));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DetailPanel relations scroll landing", () => {
  it("consumes a pending intent on open and scrolls the details pane to the bottom", async () => {
    const task = makeTask();
    requestRelationsScroll(task.id);
    const { unmount } = renderPanel(task);
    try {
      const el = pane();
      pinContentHeight(el, 500);
      await flushRaf();
      expect(el.scrollTop).toBe(500);
      // Consumed exactly once — a later open must not re-scroll.
      expect(consumeRelationsScroll(task.id)).toBe(false);
    } finally {
      unmount();
    }
  });

  it("scrolls on the event when already open on the same task", async () => {
    const task = makeTask();
    const { unmount } = renderPanel(task);
    try {
      const el = pane();
      pinContentHeight(el, 500);
      expect(el.scrollTop).toBe(0);
      document.dispatchEvent(relationsScrollEvent(task.id));
      await flushRaf();
      expect(el.scrollTop).toBe(500);
    } finally {
      unmount();
    }
  });

  it("ignores the event for a different task and leaves the pane alone without intent", async () => {
    const task = makeTask();
    const { unmount } = renderPanel(task);
    try {
      const el = pane();
      pinContentHeight(el, 500);
      document.dispatchEvent(relationsScrollEvent("some-other-task-id"));
      await flushRaf();
      expect(el.scrollTop).toBe(0);
      expect(consumeRelationsScroll(task.id)).toBe(false);
    } finally {
      unmount();
    }
  });
});
