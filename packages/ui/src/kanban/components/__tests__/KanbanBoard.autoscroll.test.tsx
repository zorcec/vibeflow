import { describe, expect, it } from "vitest";
import {
  DRAG_AUTOSCROLL_EDGE_PX,
  boardAutoScrollDelta,
} from "../KanbanBoard";

/**
 * OWNER REVERSAL of s5dfufqs (R10 updated) — strip-board drag autoscroll
 * targets the axis that actually overflows.
 *
 * The board scrolls horizontally and never wraps (`overflow-x: auto`,
 * `flex-wrap: nowrap` in kanban.css), while each lane owns its vertical
 * scroll — so on the shipped board the HORIZONTAL axis overflows whenever
 * the wide lanes do not fit, and the board itself never overflows
 * vertically. `boardAutoScrollDelta` gates each axis on live overflow:
 * horizontal-only on the shipped board, zero when nothing overflows.
 *
 * Do NOT "fix" the shipped-board fixture back to vertical-only: the owner
 * explicitly rejected the wrap layout that made x-overflow impossible.
 *
 * A 1000x600 board box is used throughout; the pointer sits 10px inside an
 * edge (well within the 60px edge band, so the delta is nonzero by the
 * `dragAutoScrollDelta` ramp, whose own suite pins the magnitudes).
 */

const BOARD = { left: 0, right: 1000, top: 0, bottom: 600 };

function stripBoard(pointerX: number, pointerY: number) {
  return boardAutoScrollDelta({
    // The shipped strip board: x overflows whenever the lanes do not fit,
    // y never overflows (lanes stretch to 100% and scroll themselves).
    canScrollX: true,
    canScrollY: false,
    pointerX,
    pointerY,
    ...BOARD,
  });
}

describe("strip-board autoscroll target/axis (R10, owner reversal)", () => {
  it("scrolls horizontally near the left/right edge", () => {
    expect(stripBoard(5, 300).dx).toBeLessThan(0);
    expect(stripBoard(995, 300).dx).toBeGreaterThan(0);
  });

  it("stays vertically still near the top/bottom edge of the board", () => {
    // The board never overflows vertically — a lane scroll owns y.
    expect(stripBoard(500, 5).dy).toBe(0);
    expect(stripBoard(500, 595).dy).toBe(0);
  });

  it("stays still in the interior of the board", () => {
    expect(stripBoard(500, 300)).toEqual({ dx: 0, dy: 0 });
  });

  it("scrolls nothing when the board does not overflow on either axis", () => {
    const still = boardAutoScrollDelta({
      canScrollX: false,
      canScrollY: false,
      pointerX: 5,
      pointerY: 300,
      ...BOARD,
    });
    expect(still).toEqual({ dx: 0, dy: 0 });
  });

  it("keeps the vertical axis for a lane that really overflows it", () => {
    const lane = boardAutoScrollDelta({
      canScrollX: false,
      canScrollY: true,
      pointerX: 500,
      pointerY: 595,
      ...BOARD,
    });
    expect(lane.dy).toBeGreaterThan(0);
    expect(lane.dx).toBe(0);
  });

  it("uses the documented edge band by default", () => {
    // Just outside the band on x: no scroll even with overflow.
    expect(stripBoard(BOARD.left + DRAG_AUTOSCROLL_EDGE_PX + 1, 300).dx).toBe(
      0,
    );
  });
});
