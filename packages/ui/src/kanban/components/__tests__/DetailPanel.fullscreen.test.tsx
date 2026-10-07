// @vitest-environment jsdom
/**
 * The detail-panel header carries a fullscreen toggle (`#dp-fullscreen-toggle`)
 * that flips the persisted `panelFullscreen` preference (ticket cba0ade6).
 * The toggle never closes the panel — close stays on `#dp-close`.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";
import type { Task } from "../../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "30-hex-task-id-0000000000",
    title: "Fullscreen task",
    status: "todo",
    type: "Task",
    priority: null,
    description: "",
    tags: [],
    comments: [],
    files: [],
    links: [],
    createdAt: new Date("2026-10-07T00:00:00Z"),
    ...overrides,
  } as unknown as Task;
}

function renderPanel(props: Partial<React.ComponentProps<typeof DetailPanel>> = {}) {
  const onToggleFullscreen = vi.fn();
  const view = render(
    <DetailPanel
      open
      task={makeTask()}
      tab="details"
      baseUrl="http://localhost:3700"
      api={
        {
          loadComments: vi.fn().mockResolvedValue([]),
          loadFiles: vi.fn().mockResolvedValue([]),
          loadBadgeCounts: vi
            .fn()
            .mockResolvedValue({ comments: 0, files: 0 }),
        } as unknown as React.ComponentProps<typeof DetailPanel>["api"]
      }
      onClose={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onPatch={vi.fn()}
      onFilePreview={vi.fn()}
      onToggleFullscreen={onToggleFullscreen}
      {...props}
    />,
  );
  return { onToggleFullscreen, ...view };
}

describe("DetailPanel fullscreen toggle", () => {
  it("renders #dp-fullscreen-toggle with aria-pressed=false by default (windowed)", () => {
    renderPanel();
    const toggle = document.querySelector("#dp-fullscreen-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("title", "Expand to fullscreen");
    expect(
      document.querySelector("#detail-panel")?.getAttribute("data-fullscreen"),
    ).toBe("false");
  });

  it("fullscreen=true swaps to the restore affordance", () => {
    renderPanel({ fullscreen: true });
    const toggle = document.querySelector("#dp-fullscreen-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("title", "Restore panel");
    expect(
      document.querySelector("#detail-panel")?.getAttribute("data-fullscreen"),
    ).toBe("true");
  });

  it("click calls onToggleFullscreen exactly once and never closes the panel", () => {
    const onClose = vi.fn();
    const { onToggleFullscreen } = renderPanel({ onClose });
    fireEvent.click(screen.getByTitle("Expand to fullscreen"));
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
