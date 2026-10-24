import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOARD_COLUMN_MIN_WIDTH_PX,
  BOARD_GAP_PX,
  BOARD_PAD_X_PX,
} from "../KanbanBoard";

/**
 * OWNER REVERSAL of ticket s5dfufqs — "Restore the horizontal scroll".
 *
 * The owner DELIBERATELY rejected the s5dfufqs/b72c5bc5 layout contract
 * (wrap + `overflow-x: hidden` + a 200px shrink floor that stacked lanes one
 * per row). The new contract, pinned below, is:
 *
 * - lanes are WIDE (320px floor) and NEVER wrap (`flex-wrap: nowrap`);
 * - when the lanes do not fit, the HORIZONTAL scrollbar belongs on
 *   `#kanban-board` (`overflow-x: auto`) — never inside a lane;
 * - every lane stretches to 100% of the board height and owns its VERTICAL
 *   scroll (`.column-scroll`, the only vertical scroller); the board never
 *   scrolls vertically (`overflow-y: hidden`).
 *
 * Do NOT "fix" these assertions back to wrap/hidden-x: the wrap era is
 * recorded here on purpose, and the red-run proof for the inversion lives
 * in the lane report (restoring `flex-wrap: wrap` / `overflow-x: hidden` on
 * the board goes red). jsdom performs no layout, so this suite pins the
 * stylesheet rules directly, plus the strip math showing the 5-lane strip
 * overflows every narrow viewport by design.
 *
 * Parts of the old guard that are STILL true and stay pinned: a lane never
 * scrolls sideways internally, and the board is the only horizontal
 * scroller (the done lane's fit-chip `overflow-y: hidden` exception is
 * pinned in the done-lane-fit suite).
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

/** Full strip width of `colCount` lanes plus gaps and board padding. */
function stripWidth(colCount: number): number {
  return (
    colCount * BOARD_COLUMN_MIN_WIDTH_PX +
    (colCount - 1) * BOARD_GAP_PX +
    BOARD_PAD_X_PX * 2
  );
}

describe("board owns the horizontal scroll (owner reversal of s5dfufqs)", () => {
  it("scrolls horizontally instead of clipping the x axis", () => {
    const block = ruleBlock("#kanban-board");
    expect(block).toMatch(/overflow-x\s*:\s*(auto|scroll)/);
    expect(block).not.toMatch(/overflow-x\s*:\s*(hidden|clip)/);
  });

  it("never wraps lanes into rows", () => {
    const block = ruleBlock("#kanban-board");
    expect(block).toMatch(/flex-wrap\s*:\s*nowrap/);
    expect(block).not.toMatch(/flex-wrap\s*:\s*wrap/);
  });

  it("never scrolls vertically — lanes own the y axis", () => {
    const block = ruleBlock("#kanban-board");
    expect(block).toMatch(/overflow-y\s*:\s*(hidden|clip)/);
    expect(block).not.toMatch(/overflow-y\s*:\s*(auto|scroll)/);
  });

  it("lanes are wider than the rejected 200px floor", () => {
    const block = ruleBlock(".board-column");
    const min = block.match(/min-width\s*:\s*(\d+)px/);
    expect(min, ".board-column must declare a min-width floor").toBeTruthy();
    const floor = Number(min![1]);
    // 320px: the readable card width (the 240px title tooltip + card
    // padding + badge cluster fit without squeezing), restored above the
    // rejected 200px wrap-era floor — and pinned to the TS single source.
    expect(floor).toBe(320);
    expect(floor).toBe(BOARD_COLUMN_MIN_WIDTH_PX);
  });

  it("lanes share spare width without a fixed strip or shrink-zero", () => {
    const block = ruleBlock(".board-column");
    expect(block).toMatch(/flex\s*:\s*1\s+1\s+0/);
    expect(block).not.toMatch(/flex\s*:\s*0\s+0\s+280px/);
    expect(block).not.toMatch(/width\s*:\s*280px/);
  });

  it("lanes stretch to the full board height without capping it", () => {
    const block = ruleBlock(".board-column");
    expect(block).toMatch(/height\s*:\s*100%/);
    expect(block).toMatch(/min-height\s*:\s*0/);
    expect(block).not.toMatch(/max-height\s*:/);
  });

  it("a lane never scrolls horizontally", () => {
    for (const selector of [".board-column", ".column-scroll"]) {
      const block = ruleBlock(selector);
      expect(block).toMatch(/overflow-x\s*:\s*(hidden|clip)/);
      expect(block).not.toMatch(/overflow-x\s*:\s*(auto|scroll)/);
    }
  });

  it("the lane scroll is the ONLY vertical scroller for tasks", () => {
    const block = ruleBlock(".column-scroll");
    expect(block).toMatch(/overflow-y\s*:\s*(auto|scroll)/);
    expect(block).toMatch(/flex\s*:\s*1\s+1\s+auto/);
    expect(block).toMatch(/min-height\s*:\s*0/);
  });
});

describe("wide-lane strip overflows narrow viewports by design", () => {
  const COLS = 5;

  it("the 5-lane strip is wider than 1280 / 768 / 390 viewports", () => {
    // 5 * 320 + 4 * 16 + 2 * 20 = 1704: every viewport below needs the
    // board's horizontal scrollbar — lanes hold 320px instead of
    // squeezing or stacking.
    expect(stripWidth(COLS)).toBe(1704);
    for (const viewport of [1280, 768, 390]) {
      expect(stripWidth(COLS)).toBeGreaterThan(viewport);
    }
  });

  it("lanes hold the floor at every viewport (no squeeze, no stack)", () => {
    expect(BOARD_COLUMN_MIN_WIDTH_PX).toBe(320);
  });
});
