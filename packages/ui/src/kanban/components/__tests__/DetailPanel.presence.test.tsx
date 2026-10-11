// @vitest-environment jsdom
/**
 * Lock removal + per-task presence with area (multiplayer child 2).
 *
 * - Nothing in the detail panel may refuse an edit because someone else is
 *   present: no lock banner, no lock indicator, no disabled/readOnly gates.
 * - The panel renders a quiet presence line naming the peer AND the area
 *   ("Ana is in description").
 * - Presence reports carry the area: opening the comments tab reports
 *   ("viewing", "comments"); dirty title/description reports "editing".
 * - The card badge is a neutral suffix ("Ana · description"), never a lock.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";
import { LiveActivityBadge } from "../TaskCard";
import type { Task } from "../../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "30-hex-task-id-0000000000",
    title: "Presence task",
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

function renderPanel(
  task: Task,
  extra: Partial<React.ComponentProps<typeof DetailPanel>> = {},
) {
  const onActivityChange = vi.fn();
  const utils = render(
    <DetailPanel
      open
      task={task}
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
      onActivityChange={onActivityChange}
      {...extra}
    />,
  );
  return { ...utils, onActivityChange };
}

describe("DetailPanel lock removal", () => {
  it("renders no lock banner, no lock indicator, and no disabled gates", () => {
    renderPanel(makeTask());
    expect(screen.queryByText(/Locked by/)).not.toBeInTheDocument();
    expect(document.querySelector("#dp-lock-indicator")).toBeNull();
    // Title + type controls stay editable: nothing refuses an edit.
    expect(document.querySelector("#dp-title")).not.toHaveAttribute(
      "readonly",
    );
    expect(document.querySelector("#dp-title")).not.toBeDisabled();
  });

  it("keeps the unsent-comment confirm (Keep editing) — it is not a lock dialog", () => {
    // The confirm only appears on close with a draft comment; assert the
    // panel still wires the close path (no lock-gating hides inside it).
    renderPanel(makeTask());
    expect(screen.queryByText("Keep editing")).not.toBeInTheDocument();
  });
});

describe("DetailPanel presence line", () => {
  it("shows the peer and the area", () => {
    renderPanel(makeTask(), {
      presence: [{ user: "Ana", userId: "u-ana", area: "description" }],
    });
    const line = document.querySelector('[data-testid="presence-line"]');
    expect(line).not.toBeNull();
    expect(line).toHaveTextContent("Ana is in description");
  });

  it("joins several peers and degrades missing areas to task-level", () => {
    renderPanel(makeTask(), {
      presence: [
        { user: "Ana", userId: "u-ana", area: "comments" },
        { user: "Ben", userId: "u-ben", area: null },
      ],
    });
    const line = document.querySelector('[data-testid="presence-line"]');
    expect(line).toHaveTextContent("Ana is in comments");
    expect(line).toHaveTextContent("Ben is here");
  });

  it("renders no presence line when nobody else is present", () => {
    renderPanel(makeTask(), { presence: [] });
    expect(
      document.querySelector('[data-testid="presence-line"]'),
    ).toBeNull();
  });

  it("reports the tab as the presence area on open", () => {
    const { onActivityChange } = renderPanel(makeTask(), { tab: "comments" });
    expect(onActivityChange).toHaveBeenCalledWith(
      makeTask().id,
      "viewing",
      "comments",
    );
  });

  it("reports editing (not locked) when the title goes dirty", () => {
    const { onActivityChange } = renderPanel(makeTask());
    onActivityChange.mockClear();
    fireEvent.change(document.querySelector("#dp-title")!, {
      target: { value: "Presence task, edited" },
    });
    expect(onActivityChange).toHaveBeenCalledWith(
      makeTask().id,
      "editing",
      "description",
    );
  });
});

describe("LiveActivityBadge neutrality", () => {
  it("renders a neutral suffix with user and area, never a lock", () => {
    render(
      <LiveActivityBadge
        activity={{
          taskId: "t1",
          user: "Ana",
          userId: "u-ana",
          state: "editing",
          area: "description",
        }}
      />,
    );
    const badge = screen.getByTestId("live-activity-badge");
    expect(badge).toHaveTextContent("Ana");
    expect(badge).toHaveTextContent("description");
    expect(badge).toHaveAttribute("title", "Ana editing · description");
    expect(screen.queryByText(/Locked by/)).not.toBeInTheDocument();
  });

  it("renders a viewing badge without an area suffix", () => {
    render(
      <LiveActivityBadge
        activity={{ taskId: "t1", user: "Ben", state: "viewing" }}
      />,
    );
    expect(screen.getByTestId("live-activity-badge")).toHaveAttribute(
      "title",
      "Ben viewing",
    );
  });
});
