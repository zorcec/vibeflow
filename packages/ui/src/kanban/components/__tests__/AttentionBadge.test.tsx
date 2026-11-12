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
import { render, fireEvent } from "@testing-library/react";
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

  it("pins the breathe animation in kanban.css (glow-only, reduced-motion static)", () => {
    // jsdom never applies the stylesheet, so the animation contract is
    // pinned by reading the CSS — same approach as the row lane-dot box
    // pin in TaskCard.leading-slot.test.tsx. The Playwright spec pins the
    // computed animation-name in a real browser.
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../kanban.css"),
      "utf-8",
    );
    const keyframes = css.match(/@keyframes attention-breathe[\s\S]*?\n\}/);
    // e54b341e (owner: the wrapper fade read as a flicker pulse, not a
    // breath): the glow itself breathes on the bell svg — drop-shadow
    // radius/alpha rise and fall while the glyph stays fully opaque. The
    // keyframes must not animate opacity at all.
    expect(keyframes?.[0]).not.toMatch(/opacity/);
    // p2udqv44cd5zqv1tiqir6ifn (owner: "still not there" after three
    // rounds): the previous 0→5px/0.5-alpha shadow measured a ~6% channel
    // delta on an 11px glyph. The peak now stacks a tight full-alpha ring
    // and a wide halo, and the trough keeps a visible amber resting glow
    // instead of alpha 0.
    expect(keyframes?.[0]).toContain(
      "drop-shadow(0 0 3px rgba(245, 158, 11, 0.95))",
    );
    expect(keyframes?.[0]).toContain(
      "drop-shadow(0 0 9px rgba(245, 158, 11, 0.6))",
    );
    expect(keyframes?.[0]).toContain(
      "drop-shadow(0 0 1px rgba(245, 158, 11, 0.35))",
    );
    expect(keyframes?.[0]).not.toContain("drop-shadow(0 0 0 rgba");
    // The animation is declared on the svg, not the wrapper: one shared
    // rule covers the card, the child row and the detail header (all
    // three render AttentionBadge).
    const rule = css.match(/\.attention-indicator svg \{[\s\S]*?\}/);
    expect(rule?.[0]).toContain("attention-breathe");
    expect(rule?.[0]).toMatch(/3s ease-in-out infinite/);
    const wrapperRule = css.match(/\.attention-indicator \{[\s\S]*?\}/);
    expect(wrapperRule?.[0]).not.toContain("animation");
    // Reduced motion: no motion, but the flag still reads as a static
    // amber glow — `filter: none` left the bell indistinguishable from a
    // plain glyph for every reduce-motion viewer.
    const reduced = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.attention-indicator svg[\s\S]*?\}/,
    );
    expect(reduced?.[0]).toContain("animation: none");
    expect(reduced?.[0]).toContain("opacity: 1");
    expect(reduced?.[0]).toContain(
      "filter: drop-shadow(0 0 3px rgba(245, 158, 11, 0.55))",
    );
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

  it("renders a pressable button wrapper when onPress is provided (round 2)", async () => {
    const onPress = vi.fn();
    const { container } = render(
      <AttentionBadge flagged onPress={onPress} />,
    );
    const button = container.querySelector(
      'button[data-attention-press="true"]',
    );
    expect(button).not.toBeNull();
    expect(button).toHaveAttribute(
      "aria-label",
      "Needs attention — open the activity feed",
    );
    // The inner glyph keeps its role/title/aria contract, so the
    // non-interactive selectors keep resolving.
    const glyph = container.querySelector(
      '[data-attention-state="flagged"]',
    );
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveAttribute("role", "img");
    expect(glyph).toHaveAttribute("aria-label", "Needs attention");
    expect(glyph?.querySelector("svg")).not.toBeNull();
    expectNoPillText(container);
    fireEvent.click(button!);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("renders no button without onPress (byte-identical non-interactive)", () => {
    const { container } = render(<AttentionBadge flagged />);
    expect(
      container.querySelector('button[data-attention-press="true"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-attention-state="flagged"]'),
    ).not.toBeNull();
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
  function renderCard(task: Task, onOpen = vi.fn()) {
    return {
      ...render(
        <TaskCard
          task={task}
          col={col}
          allTasks={[task]}
          currentUserId="user-1"
          onOpen={onOpen}
          onDragStart={vi.fn()}
        />,
      ),
      onOpen,
    };
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

  it("bell click opens the detail panel on the activities tab (round 2)", () => {
    const task = makeTask({ needsAttention: true, openedBy: ["user-1"] });
    const { container, onOpen, unmount } = renderCard(task);
    const bell = container.querySelector(
      'button[data-attention-press="true"]',
    );
    expect(bell).not.toBeNull();
    fireEvent.click(bell!);
    // Tab-targeted open: the reason tab, not the default details tab.
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(task, "comments");
    unmount();
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

  it("bell click jumps to the activities tab while the row body opens details (round 2)", () => {
    const onOpen = vi.fn();
    const { container, unmount } = render(
      <ChildRow
        child={makeTask({ needsAttention: true })}
        variant="inline"
        depth={1}
        onOpen={onOpen}
      />,
    );
    const bell = container.querySelector(
      'button[data-attention-press="true"]',
    );
    expect(bell).not.toBeNull();
    fireEvent.click(bell!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("comments");
    // The row body keeps the default (details) open — no tab target.
    onOpen.mockClear();
    fireEvent.click(
      container.querySelector('[data-role="child-link-row"]')!,
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith();
    unmount();
  });
});

describe("DetailPanel needs-attention icon", () => {
  it("shows the icon in the detail header for a flagged task", () => {
    const { container, unmount } = renderPanel(
      makeTask({ needsAttention: true }) as unknown as Task,
    );
    const row = container.querySelector("#dp-attention-row");
    expect(row).not.toBeNull();
    // e25639f: the wrapper no longer duplicates the hook — the badge
    // glyph inside carries `data-attention-state="flagged"`.
    expect(row).not.toHaveAttribute("data-attention-state");
    const badge = row?.querySelector('[data-attention-state="flagged"]');
    expect(badge).not.toBeNull();
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

  it("header bell click switches to the activities tab (round 2)", () => {
    const { container, unmount } = renderPanel(
      makeTask({ needsAttention: true }) as unknown as Task,
    );
    // The active tab carries the exact `active` class TOKEN. A substring check
    // would now pass on the Button primitive's `active:` utility variants
    // (P14.3), which say nothing about which tab is selected.
    const hasActiveToken = (el: Element | null) =>
      (el?.className ?? "").split(/\s+/).includes("active");
    expect(hasActiveToken(container.querySelector("#dp-tab-details"))).toBe(true);
    const bell = container.querySelector(
      '#dp-attention-row button[data-attention-press="true"]',
    );
    expect(bell).not.toBeNull();
    fireEvent.click(bell!);
    expect(hasActiveToken(container.querySelector("#dp-tab-activity"))).toBe(true);
    expect(hasActiveToken(container.querySelector("#dp-tab-details"))).toBe(false);
    unmount();
  });
});
