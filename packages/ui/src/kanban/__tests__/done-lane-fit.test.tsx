/**
 * Done-lane fit contract (8fbdb8c8 — "The last done item is cut off").
 *
 * The done scroll container is `overflow-y: hidden` BY DESIGN (it fits to
 * screen instead of scrolling), so `doneLaneFitCount` must reserve the
 * overflow chip's real height exactly: N cards + chip need
 * N * (cardH + gap) + chipH + gap + scrollPadBottom <= colHeight.
 *
 * The previous revision reserved only 29px (`CHIP_H - gap`, CHIP_H = 34)
 * against a real need of ~56px. At short viewport heights the ~27px excess
 * passed flex-shrink's min-content floor and the `+N more` chip was cut off
 * by the column (measured: chip bottom +12.8px past the scroll container's
 * client bottom at 800x575 with 1500 done cards, scrollHeight >
 * clientHeight — clipped by the COLUMN, not the board or the viewport).
 * Tall viewports masked it: flex-shrink absorbed a few px per card.
 *
 * Non-vacuity: the "old formula claims 9 fit" assertion below reproduces
 * the pre-fix arithmetic, and every CSS pin was read off the shipped
 * kanban.css. The Playwright sweep (report) shows the old formula
 * overflowing at 8 of 19 viewport heights while the new one fits all.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import {
  doneLaneFitCount,
  DONE_FIT_CHIP_H,
  DONE_FIT_CHIP_RESERVE,
  DONE_FIT_COLUMN_GAP,
  DONE_FIT_SCROLL_PAD_BOTTOM,
  KanbanBoard,
} from "../components/KanbanBoard";
import { dragSession } from "../task-links";
import type { Task } from "../types";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(TEST_DIR, "../kanban.css"), "utf-8");
const BOARD_SRC = readFileSync(
  resolve(TEST_DIR, "../components/KanbanBoard.tsx"),
  "utf-8",
);

function blocks(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g");
  return [...CSS.matchAll(re)].map((m) => m[1]);
}

function decl(block: string, prop: string): string {
  const m = block.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`));
  if (!m) throw new Error(`missing ${prop} declaration in block: ${block}`);
  return m[1].trim();
}

describe("doneLaneFitCount reserves the chip's real height (8fbdb8c8)", () => {
  it("returns 0 for degenerate inputs and at least 1 otherwise", () => {
    expect(doneLaneFitCount(0, 40)).toBe(0);
    expect(doneLaneFitCount(480, 0)).toBe(0);
    expect(doneLaneFitCount(-10, 40)).toBe(0);
    expect(doneLaneFitCount(40, 40)).toBe(1);
  });

  it("the regression pair: a lane the old formula overflowed", () => {
    // colH = 455, cardH = 42. Old arithmetic floor((455 - 29) / 47) = 9,
    // but 9 cards + the real chip need 9 * 47 + 50.8 = 473.8 > 455: the
    // chip stuck ~19px past the hidden-overflow container (minus whatever
    // flex-shrink absorbed) and was cut. The fixed count is 8.
    const colH = 455;
    const cardH = 42;
    expect(Math.floor((colH - 29) / (cardH + 5))).toBe(9);
    expect(doneLaneFitCount(colH, cardH)).toBe(8);
  });

  it("never overflows the hidden container across lane/card sizes", () => {
    // fit * (cardH + gap) + reserve <= colH for every plausible geometry.
    for (let colH = 200; colH <= 1200; colH += 7) {
      for (let cardH = 30; cardH <= 80; cardH += 3) {
        const fit = doneLaneFitCount(colH, cardH);
        expect(fit).toBeGreaterThanOrEqual(1);
        expect(fit * (cardH + DONE_FIT_COLUMN_GAP) + DONE_FIT_CHIP_RESERVE)
          .toBeLessThanOrEqual(colH);
      }
    }
  });
});

describe("fit constants match the shipped styles", () => {
  it("column gap and bottom pad equal the .column-scroll declarations", () => {
    const scroll = blocks(".column-scroll");
    expect(scroll.length).toBeGreaterThanOrEqual(1);
    expect(decl(scroll[0], "gap")).toBe(`${DONE_FIT_COLUMN_GAP}px`);
    expect(decl(scroll[0], "padding-bottom")).toBe(
      `${DONE_FIT_SCROLL_PAD_BOTTOM}px`,
    );
  });

  it("the done scroll container cannot scroll — exactness is required", () => {
    // If this ever becomes `auto`, the fit math degrades to an aesthetic
    // choice instead of the thing preventing a clipped chip.
    const done = blocks('.column-scroll[data-status="done"]');
    expect(done).toHaveLength(1);
    expect(decl(done[0], "overflow-y")).toBe("hidden");
  });

  it("the chip reserve covers the chip's own inline styles", () => {
    // The chip lives in KanbanBoard.tsx as inline styles; recompute its
    // natural height from those literals and require the constant to
    // cover it. A chip restyle (padding/border/font) goes red here.
    // Source order in the chip's style object: border, padding, fontSize,
    // …, lineHeight. Groups: borderW, padV, fontSize, lineHeight.
    const chipStyle = BOARD_SRC.match(
      /data-fit-chip[\s\S]*?border:\s*"(\d+)px[\s\S]*?padding:\s*"(\d+)px \d+px"[\s\S]*?fontSize:\s*(\d+)[\s\S]*?lineHeight:\s*([\d.]+)/,
    );
    expect(chipStyle).not.toBeNull();
    const [, borderW, padV, fontSize, lineHeight] = chipStyle!.map(Number);
    const natural = 2 * padV + fontSize * lineHeight + 2 * borderW;
    expect(natural).toBeLessThanOrEqual(DONE_FIT_CHIP_H);
    // ...but not by a whole card row: the lane must not hide cards it
    // could show. (cardH + gap is >= 35 for any real card.)
    expect(DONE_FIT_CHIP_H - natural).toBeLessThan(35);
  });
});

describe("card must not shift on hover (2aefa368 guard)", () => {
  it(".task-card:hover carries no transform", () => {
    const hover = blocks(".task-card:hover");
    expect(hover).toHaveLength(1);
    expect(hover[0]).not.toMatch(/transform\s*:/);
  });
});

describe("done lane stays a working drop target with hint lifecycle", () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver; without it the lane's measure effect
    // throws and React tears down the render. rAF runs synchronously so
    // the card-height probe settles deterministically (clientHeight is 0
    // in jsdom, so the lane renders the DONE_LIMIT fallback — fine for
    // wiring assertions, which do not depend on the fit count).
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // requestAnimationFrame never fires: the drag auto-scroll loop would
    // otherwise recurse synchronously to a stack overflow, and the
    // card-height probe is irrelevant here (clientHeight is 0 in jsdom,
    // so the lane renders the DONE_LIMIT fallback either way).
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    cleanup();
    dragSession.end();
    vi.unstubAllGlobals();
  });

  const doneTasks: Task[] = Array.from({ length: 12 }, (_, i) => ({
    id: `done-${i}`,
    title: `Done task ${i}`,
    status: "done" as const,
  }));

  function renderBoard(handlers: {
    onDrop?: (taskId: string, status: Task["status"]) => void;
    onReorder?: (...args: any[]) => void;
  } = {}) {
    return render(
      <KanbanBoard
        tasks={doneTasks}
        visibleCols={["done"]}
        searchQuery=""
        onOpenPanel={() => {}}
        onDrop={handlers.onDrop ?? (() => {})}
        onReorder={handlers.onReorder}
      />,
    );
  }

  it("dropping onto the done column calls onDrop with done", () => {
    const onDrop = vi.fn();
    const { container } = renderBoard({ onDrop });
    const section = container.querySelector(
      'section.board-column[data-column-id="done"]',
    ) as HTMLElement;
    expect(section).not.toBeNull();
    // Register a drag source the way a tree-row drag does (session only,
    // no card ref) so the test proves the COLUMN wiring, not the card's.
    dragSession.begin("done-3");
    fireEvent.drop(section);
    expect(onDrop).toHaveBeenCalledWith("done-3", "done");
  });

  it("drag hides done cards, shows the drop hint, drop restores cards", async () => {
    const onDrop = vi.fn();
    const { container } = renderBoard({ onDrop });
    const section = container.querySelector(
      'section.board-column[data-column-id="done"]',
    ) as HTMLElement;
    const card = container.querySelector(
      '[data-task-id="done-11"]',
    ) as HTMLElement;
    expect(card).not.toBeNull();

    fireEvent.dragStart(card);
    await waitFor(() => {
      expect(
        container.querySelector("[data-done-drop-hint]"),
      ).not.toBeNull();
    });
    // Cards hidden while the hint shows (43f03542 behaviour).
    expect(container.querySelector('[data-task-id="done-11"]')).toBeNull();

    fireEvent.drop(section);
    expect(onDrop).toHaveBeenCalledWith("done-11", "done");
    await waitFor(() => {
      expect(container.querySelector("[data-done-drop-hint]")).toBeNull();
    });
    // Cards restored after the drop.
    expect(
      container.querySelector('[data-task-id="done-11"]'),
    ).not.toBeNull();
  });
});
