// @vitest-environment jsdom
/**
 * Details author tile (ticket 0b7c45c5 — "Agent icon").
 *
 * The tile reads the same shared attribution rule as the card and the
 * feed: the human behind the task. Task-level agent-involvement is not
 * stored anywhere (pushActor/author/assigneeId are all the human's values
 * even for agent pushes), so the tile honestly renders unbadged — no badge
 * is better than a wrong one.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TaskDetailsTab } from "../shared/TaskDetailsTab";
import type { Task } from "../../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "author-tile-task",
    title: "Author tile task",
    status: "todo",
    ...overrides,
  } as unknown as Task;
}

function renderTab(task: Task) {
  return render(
    <TaskDetailsTab
      task={task}
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

function authorTileText(container: HTMLElement): string | null {
  return container.querySelector("#dp-author")?.textContent ?? null;
}

describe("TaskDetailsTab author tile attribution", () => {
  it("names the stored human with no agent badge", () => {
    const { container } = renderTab(makeTask({ author: "Tomislav Zorcec" }));
    const text = authorTileText(container) ?? "";
    expect(text).toContain("Tomislav Zorcec");
    expect(text).not.toContain("🤖");
  });

  it("prefers the joined authorName when present", () => {
    const { container } = renderTab(
      makeTask({ author: "agent", authorName: "Tomislav Zorcec" }),
    );
    const text = authorTileText(container) ?? "";
    expect(text).toContain("Tomislav Zorcec");
  });

  it("never badges from the free-text task author — 'agent' there proves nothing", () => {
    // `tasks.author` is a display string, not the comment vocabulary: an
    // agent-created task stores the token owner's human name here. The
    // tile must not guess agent-involvement from this string.
    const { container } = renderTab(makeTask({ author: "agent" }));
    const text = authorTileText(container) ?? "";
    expect(text).not.toContain("\u{1F916}");
  });

  it("renders neutrally when nobody is named — never a bare agent", () => {
    const { container } = renderTab(makeTask({}));
    const text = authorTileText(container) ?? "";
    expect(text).not.toContain("🤖");
  });
});
