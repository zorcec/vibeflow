import { describe, expect, it } from "vitest";
import {
  DRAG_AUTOSCROLL_EDGE_PX,
  boardAutoScrollDelta,
} from "../KanbanBoard";

/**
 * R10 on s5dfufqs — wrapped-board drag autoscroll targets the axis that
 * actually overflows.
 *
 * The board wraps (`flex-wrap`, `overflow-x: hidden` in kanban.css), so the
 * horizontal axis NEVER overflows: the old loop's unconditional
 * `board.scrollLeft += dx` was a dead write, and dragging near the
 * top/bottom edge of a board whose lanes wrapped below the fold scrolled
 * nothing. `boardAutoScrollDelta` gates each axis on live overflow:
 * vertical-only on the shipped board, zero when nothing overflows.
 *
 * A 1000x600 board box is used throughout; the pointer sits 10px inside an
 * edge (well within the 60px edge band, so the delta is nonzero by the
 * `dragAutoScrollDelta` ramp, whose own suite pins the magnitudes).
 */

const BOARD = { left: 0, right: 1000, top: 0, bottom: 600 };

function wrappedBoard(pointerX: number, pointerY: number) {
  return boardAutoScrollDelta({
    // The shipped wrapped board: x never overflows, y does when lanes wrap
    // below the fold.
    canScrollX: false,
    canScrollY: true,
    pointerX,
    pointerY,
    ...BOARD,
  });
}

describe("wrapped-board autoscroll target/axis (R10)", () => {
  it("never scrolls horizontally on a wrapped board, even at the x edge", () => {
    expect(wrappedBoard(5, 300).dx).toBe(0);
    expect(wrappedBoard(995, 300).dx).toBe(0);
  });

  it("scrolls vertically near the top/bottom edge of an overflowing board", () => {
    expect(wrappedBoard(500, 5).dy).toBeLessThan(0);
    expect(wrappedBoard(500, 595).dy).toBeGreaterThan(0);
  });

  it("stays still in the interior of the board", () => {
    expect(wrappedBoard(500, 300)).toEqual({ dx: 0, dy: 0 });
  });

  it("scrolls nothing when the board does not overflow on either axis", () => {
    const still = boardAutoScrollDelta({
      canScrollX: false,
      canScrollY: false,
      pointerX: 5,
      pointerY: 5,
      ...BOARD,
    });
    expect(still).toEqual({ dx: 0, dy: 0 });
  });

  it("keeps the horizontal axis for a host that really overflows it", () => {
    const legacy = boardAutoScrollDelta({
      canScrollX: true,
      canScrollY: false,
      pointerX: 995,
      pointerY: 300,
      ...BOARD,
    });
    expect(legacy.dx).toBeGreaterThan(0);
    expect(legacy.dy).toBe(0);
  });

  it("uses the documented edge band by default", () => {
    // Just outside the band on y: no scroll even with overflow.
    expect(
      wrappedBoard(500, BOARD.top + DRAG_AUTOSCROLL_EDGE_PX + 1).dy,
    ).toBe(0);
  });
});
