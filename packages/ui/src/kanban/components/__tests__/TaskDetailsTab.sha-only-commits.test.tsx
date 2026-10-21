// @vitest-environment jsdom
/**
 * Regression: a commit that carries only `sha` must not crash the details tab.
 *
 * Records mirrored from the CLI store `commits: [{ sha, authorEmail }]` — no
 * `message`, no `timestamp`. The component's parameter type claims both are
 * always strings, so `c.message.slice(0, 60)` threw
 *   TypeError: Cannot read properties of undefined (reading 'slice')
 * for every such commit once real board data reached the UI (production stack:
 * an Array.map inside the commit tooltip). The panel must render these.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TaskDetailsTab } from "../shared/TaskDetailsTab";
import type { Task } from "../../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "sha-only-task",
    title: "Commit without message",
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

const SHA_ONLY = [{ sha: "0123456789abcdef0123456789abcdef01234567", authorEmail: "a@b.test" }];

describe("TaskDetailsTab commits", () => {
  it("renders a single sha-only commit without throwing", () => {
    expect(() => renderTab(makeTask({ commits: SHA_ONLY } as unknown as Partial<Task>))).not.toThrow();
    expect(screen.getByText(/01234567/)).toBeInTheDocument();
  });

  it("renders several sha-only commits (the tooltip map that crashed)", () => {
    const commits = [
      ...SHA_ONLY,
      { sha: "fedcba9876543210fedcba9876543210fedcba98", authorEmail: "c@d.test" },
      { sha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" },
    ];
    expect(() => renderTab(makeTask({ commits } as unknown as Partial<Task>))).not.toThrow();
  });

  it("still renders a commit that does carry message and timestamp", () => {
    const commits = [
      {
        sha: "1111222233334444555566667777888899990000",
        message: "feat: real message",
        timestamp: "2026-10-01T10:00:00Z",
      },
    ];
    renderTab(makeTask({ commits } as unknown as Partial<Task>));
    expect(screen.getByText(/11112222/)).toBeInTheDocument();
  });
});
