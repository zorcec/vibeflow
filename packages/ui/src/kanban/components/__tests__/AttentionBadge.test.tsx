// @vitest-environment jsdom
/**
 * Needs-attention indicator (ticket 0752d55c): an amber BELL icon in the
 * VerifyIndicator treatment — NOT a tag pill. Fed by the task's
 * `needsAttention` field; the reason lives in the activity feed.
 *
 * Owner order: the marker must not look like a tag pill. Every surface
 * (card title row, child row, detail header) renders the same AttentionBadge
 * icon alongside its leading status/verify slot, at the same optical sizes
 * as VerifyIndicator (11 card + detail header, 10 tree row). Bell was chosen
 * over AlertCircle because AlertCircle is already the failed-verification
 * glyph — reusing it would conflate "flagged for attention" with "work NOT
 * implemented correctly".
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AttentionBadge } from "../../../AttentionBadge";
import { BadgeCluster, TaskCard } from "../TaskCard";
import { ChildRow } from "../ChildRow";
import { DetailPanel } from "../DetailPanel";
import type { Column, Task } from "../../types";

const col: Column = {
  id: "todo",
  label: "Todo",
  color: "#f59e0b",
  accent: "#f59e0b",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "attention-task",
    title: "Flagged task",
    status: "todo",
    type: "Task",
    ...overrides,
  };
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

/** The old pill rendered uppercase text; the icon variant renders no text. */
function expectNoPillText(container: HTMLElement) {
  for (const el of Array.from(
    container.querySelectorAll('[data-attention-state="flagged"]'),
  )) {
    expect(el.textContent?.trim() ?? "").toBe("");
  }
  expect(container.textContent).not.toContain("NEEDS ATTENTION");
}

describe("AttentionBadge", () => {
  it("renders the bell icon with the flagged hook when flagged", () => {
    const { container } = render(<AttentionBadge flagged />);
    const badge = container.querySelector(
      '[data-attention-state="flagged"]',
    );
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute("role", "img");
    expect(badge).toHaveAttribute("aria-label", "Needs attention");
    expect(badge?.getAttribute("title")).toContain("activity feed");
    // Icon variant: a lucide glyph, no pill text.
    expect(badge?.querySelector("svg")).not.toBeNull();
    // Breathing hook (CSS-only pulse, shared by card + row + header).
    expect(badge).toHaveClass("attention-indicator");
    expectNoPillText(container);
  });

  it("pins the breathe animation in kanban.css (faint, reduced-motion static)", () => {
    // jsdom never applies the stylesheet, so the animation contract is
    // pinned by reading the CSS — same approach as the row lane-dot box
    // pin in TaskCard.leading-slot.test.tsx. The Playwright spec pins the
    // computed animation-name in a real browser.
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../kanban.css"),
      "utf-8",
    );
    const keyframes = css.match(/@keyframes attention-breathe[\s\S]*?\n\}/);
    expect(keyframes?.[0]).toContain("rgba(245, 158, 11, 0.12)");
    const rule = css.match(/\.attention-indicator \{[\s\S]*?\}/);
    expect(rule?.[0]).toContain("attention-breathe");
    expect(rule?.[0]).toMatch(/2s ease-in-out infinite/);
    const reduced = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.attention-indicator[\s\S]*?\}/,
    );
    expect(reduced?.[0]).toContain("animation: none");
  });

  it("sizes the glyph to the neighbouring slot (11 card, 10 tree row)", () => {
    const card = render(<AttentionBadge flagged />);
    expect(
      card.container.querySelector(
        '[data-attention-state="flagged"] svg',
      ),
    ).toHaveStyle({ width: "11px", height: "11px" });
    card.unmount();
    const row = render(<AttentionBadge flagged size={10} />);
    expect(
      row.container.querySelector(
        '[data-attention-state="flagged"] svg',
      ),
    ).toHaveStyle({ width: "10px", height: "10px" });
    row.unmount();
  });

  it("renders nothing when not flagged", () => {
    const { container } = render(<AttentionBadge />);
    expect(container.textContent).toBe("");
    const { container: absent } = render(
      <AttentionBadge flagged={false} />,
    );
    expect(absent.textContent).toBe("");
  });
});

describe("BadgeCluster needs-attention", () => {
  it("never renders the attention marker — it lives in the title row, not the badge row", () => {
    const { container } = render(<BadgeCluster type="Task" />);
    expect(
      container.querySelector('[data-attention-state="flagged"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Needs attention");
  });
});

describe("TaskCard needs-attention icon", () => {
  function renderCard(task: Task) {
    return render(
      <TaskCard
        task={task}
        col={col}
        allTasks={[task]}
        currentUserId="user-1"
        onOpen={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );
  }

  it("shows the icon alongside the leading slot for a flagged task", () => {
    const task = makeTask({ needsAttention: true, openedBy: ["user-1"] });
    const { container, unmount } = renderCard(task);
    const badge = container.querySelector(
      '[data-attention-state="flagged"]',
    );
    expect(badge).not.toBeNull();
    expect(badge?.querySelector("svg")).not.toBeNull();
    // Alongside the leading slot: before the title in the title row.
    const title = container.querySelector('[data-role="card-title"]');
    expect(title).not.toBeNull();
    expect(
      badge!.compareDocumentPosition(title!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // No pill text anywhere on the card.
    expectNoPillText(container);
    unmount();
  });

  it("omits the icon when the flag is absent or cleared", () => {
    for (const task of [
      makeTask({ openedBy: ["user-1"] }),
      makeTask({ needsAttention: false, openedBy: ["user-1"] }),
    ]) {
      const { container, unmount } = renderCard(task);
      expect(
        container.querySelector('[data-attention-state="flagged"]'),
      ).toBeNull();
      unmount();
    }
  });
});

describe("ChildRow needs-attention icon", () => {
  it("shows the 10px icon alongside the leading slot, before the title", () => {
    for (const variant of ["inline", "detail", "popover"] as const) {
      const { container, unmount } = render(
        <ChildRow
          child={makeTask({ needsAttention: true })}
          variant={variant}
          depth={1}
        />,
      );
      const badge = container.querySelector(
        '[data-attention-state="flagged"]',
      );
      expect(badge).not.toBeNull();
      const glyph = badge?.querySelector("svg");
      expect(glyph).not.toBeNull();
      expect(glyph).toHaveStyle({ width: "10px", height: "10px" });
      // Alongside the leading slot: before the title text.
      const title = container.querySelector(".child-link-title");
      expect(title).not.toBeNull();
      expect(
        badge!.compareDocumentPosition(title!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expectNoPillText(container);
      unmount();
    }
  });

  it("omits the icon when the flag is absent", () => {
    const { container } = render(
      <ChildRow child={makeTask()} variant="inline" depth={1} />,
    );
    expect(
      container.querySelector('[data-attention-state="flagged"]'),
    ).toBeNull();
  });
});

describe("DetailPanel needs-attention icon", () => {
  it("shows the icon in the detail header for a flagged task", () => {
    const { container, unmount } = renderPanel(
      makeTask({ needsAttention: true }) as unknown as Task,
    );
    const row = container.querySelector("#dp-attention-row");
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("data-attention-state", "flagged");
    const badge = row?.querySelector('[data-attention-state="flagged"]');
    expect(badge?.querySelector("svg")).not.toBeNull();
    expectNoPillText(container);
    unmount();
  });

  it("omits the header marker when the flag is absent", () => {
    const { container, unmount } = renderPanel(
      makeTask() as unknown as Task,
    );
    expect(container.querySelector("#dp-attention-row")).toBeNull();
    unmount();
  });
});
