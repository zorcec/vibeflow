import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOARD_COLUMN_MIN_WIDTH_PX,
  BOARD_GAP_PX,
  BOARD_PAD_X_PX,
  boardColumnsPerRow,
  boardColumnWidth,
} from "../KanbanBoard";

/**
 * Ticket s5dfufqs — "Remove horizontal scroll".
 *
 * The board used to force a fixed-width strip (`flex: 0 0 280px` columns in
 * an `overflow-x: auto` container), so viewports narrower than the strip got
 * a horizontal page scrollbar. Columns now shrink to share the viewport and
 * wrap/stack below a readable floor, and the board clips the x axis — so
 * `scrollWidth <= clientWidth` holds at every width.
 *
 * jsdom performs no layout, so this suite pins the two halves that together
 * guarantee it: (1) the stylesheet rules that make overflow impossible, and
 * (2) the exported geometry math, measured at 1280 / 768 / 390, showing the
 * fitted row never exceeds the viewport and no column becomes a sliver.
 */

const cssPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../kanban.css",
);

function ruleBlock(selector: string): string {
  const css = readFileSync(cssPath, "utf-8");
  const match = css.match(
    new RegExp(`${selector.replace(/[#.]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
  );
  expect(match, `${selector} rule must exist in kanban.css`).toBeTruthy();
  return match![1];
}

describe("board has no horizontal scroll (s5dfufqs)", () => {
  it("clips the horizontal axis instead of scrolling it", () => {
    const block = ruleBlock("#kanban-board");
    expect(block).not.toMatch(/overflow-x\s*:\s*(auto|scroll)/);
    expect(block).toMatch(/overflow-x\s*:\s*(hidden|clip)/);
  });

  it("wraps columns instead of forcing a strip", () => {
    expect(ruleBlock("#kanban-board")).toMatch(/flex-wrap\s*:\s*wrap/);
  });

  it("columns shrink (no fixed 280px strip, no shrink-zero)", () => {
    const block = ruleBlock(".board-column");
    expect(block).not.toMatch(/flex\s*:\s*0\s+0\s+280px/);
    expect(block).not.toMatch(/width\s*:\s*280px/);
  });

  it("columns keep a readable floor (never 40px slivers)", () => {
    const block = ruleBlock(".board-column");
    const min = block.match(/min-width\s*:\s*(\d+)px/);
    expect(min, ".board-column must declare a min-width floor").toBeTruthy();
    const floor = Number(min![1]);
    expect(floor).toBeGreaterThanOrEqual(160);
    expect(floor).toBe(BOARD_COLUMN_MIN_WIDTH_PX);
  });
});

describe("fitted geometry at 1280 / 768 / 390 (s5dfufqs)", () => {
  const COLS = 5;

  for (const viewport of [1280, 768, 390]) {
    it(`scrollWidth <= clientWidth at ${viewport}px`, () => {
      const perRow = boardColumnsPerRow(viewport, COLS);
      const width = boardColumnWidth(viewport, COLS);
      // The rendered row: perRow columns at the fitted width plus gaps.
      const scrollWidth = perRow * width + (perRow - 1) * BOARD_GAP_PX;
      const clientWidth = viewport - BOARD_PAD_X_PX * 2;
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1e-6);
    });

    it(`columns stay readable at ${viewport}px (width >= floor)`, () => {
      expect(boardColumnWidth(viewport, COLS)).toBeGreaterThanOrEqual(
        BOARD_COLUMN_MIN_WIDTH_PX,
      );
    });
  }

  it("stacks one per row at 390px instead of squeezing five slivers", () => {
    expect(boardColumnsPerRow(390, COLS)).toBe(1);
    expect(boardColumnWidth(390, COLS)).toBeGreaterThan(300);
  });

  it("keeps all five in one row at 1280px", () => {
    expect(boardColumnsPerRow(1280, COLS)).toBe(5);
  });
});
