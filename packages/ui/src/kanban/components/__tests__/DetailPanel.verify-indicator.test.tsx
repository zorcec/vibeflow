// @vitest-environment jsdom
/**
 * The details pane must SHOW the verification verdict (80df86ed), inlined
 * with the status chips (e0eb1b08).
 *
 * The status cluster carries a `#dp-verify-row`: the shared VerifyIndicator
 * glyph plus one quiet verdict word — no uppercase label, no separate row. It
 * reads the task through `displayedVerifyState` — the same single gate the
 * card and the child rows use — so a task in a non-verdict lane or one
 * carrying no verdict renders no row at all, and the indicator's title is the
 * hover tooltip that explains what the verdict means.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";
import type { Task } from "../../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "30-hex-task-id-0000000000",
    title: "Verified task",
    status: "review",
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

function renderPanel(task: Task) {
  return render(
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
    />,
  );
}

describe("DetailPanel verification row", () => {
  it("shows the inline indicator, the verdict word and the tooltip for verified=true", () => {
    renderPanel(makeTask({ verified: true }));
    const row = document.querySelector("#dp-verify-row");
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("data-verify-state", "verified");
    // Inlined with the status chips: no separate "Verification" label row.
    expect(screen.queryByText("Verification")).not.toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
    // The verdict keeps a span first child (annotated selector target).
    expect(row!.querySelector("span:nth-child(1)")).not.toBeNull();
    const glyph = row!.querySelector(".verify-indicator");
    expect(glyph).toHaveAttribute(
      "title",
      "Verified — the agent attested this task IS implemented correctly",
    );
    expect(glyph).toHaveAttribute(
      "aria-label",
      "Verified — implemented correctly",
    );
  });

  it("shows the failed verdict for verified=false", () => {
    renderPanel(makeTask({ verified: false }));
    const row = document.querySelector("#dp-verify-row");
    expect(row).toHaveAttribute("data-verify-state", "failed");
    expect(screen.getByText("Verification failed")).toBeInTheDocument();
    const glyph = row!.querySelector(".verify-indicator");
    expect(glyph).toHaveAttribute(
      "title",
      "Failed verification — the agent attested this task is NOT implemented correctly",
    );
    expect(glyph).toHaveAttribute(
      "aria-label",
      "Failed verification — not implemented correctly",
    );
  });

  it("right-aligns the row at the status cluster's right edge", () => {
    renderPanel(makeTask({ verified: true }));
    const row = document.querySelector("#dp-verify-row") as HTMLElement;
    expect(row).not.toBeNull();
    // margin-left:auto on the flex item pushes it to the row's right edge
    // while it stays in the same status-chip flex parent.
    expect(row.style.marginLeft).toBe("auto");
    expect(row.parentElement!.style.display).toContain("flex");
  });

  it("renders no row when the task carries no verdict", () => {
    renderPanel(makeTask({ verified: undefined }));
    expect(document.querySelector("#dp-verify-row")).toBeNull();
  });

  it("renders no row for a verdict outside the verdict lanes", () => {
    renderPanel(makeTask({ status: "todo", verified: true }));
    expect(document.querySelector("#dp-verify-row")).toBeNull();
  });
});
