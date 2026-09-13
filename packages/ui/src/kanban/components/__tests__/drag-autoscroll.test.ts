import { describe, it, expect } from "vitest";
import {
  dragAutoScrollDelta,
  DRAG_AUTOSCROLL_EDGE_PX,
  DRAG_AUTOSCROLL_MAX_SPEED_PX,
} from "../KanbanBoard";

/**
 * Edge auto-scroll ramp for drag reachability (d4814bb7).
 *
 * The behaviour itself is covered end-to-end with a real pointer in
 * packages/cli/tests/playwright/kanban-drag-real-pointer.test.ts; this pins the
 * pure geometry: no movement in the interior, movement toward whichever edge the
 * pointer is near, full speed once it is held at (or past) the edge.
 */
describe("dragAutoScrollDelta", () => {
  const START = 100;
  const END = 600;

  it("does not scroll while the pointer is in the interior", () => {
    expect(dragAutoScrollDelta(350, START, END)).toBe(0);
    expect(
      dragAutoScrollDelta(END - DRAG_AUTOSCROLL_EDGE_PX, START, END),
    ).toBe(0);
  });

  it("scrolls up/left near the start edge", () => {
    expect(dragAutoScrollDelta(START, START, END)).toBeLessThan(0);
    expect(
      dragAutoScrollDelta(START + DRAG_AUTOSCROLL_EDGE_PX / 2, START, END),
    ).toBeLessThan(0);
  });

  it("scrolls down/right near the end edge", () => {
    expect(dragAutoScrollDelta(END, START, END)).toBeGreaterThan(0);
    expect(
      dragAutoScrollDelta(END - DRAG_AUTOSCROLL_EDGE_PX / 2, START, END),
    ).toBeGreaterThan(0);
  });

  it("holds full speed once the pointer is at or past the edge", () => {
    expect(dragAutoScrollDelta(END, START, END)).toBe(
      DRAG_AUTOSCROLL_MAX_SPEED_PX,
    );
    expect(dragAutoScrollDelta(END + 500, START, END)).toBe(
      DRAG_AUTOSCROLL_MAX_SPEED_PX,
    );
    expect(dragAutoScrollDelta(START - 500, START, END)).toBe(
      -DRAG_AUTOSCROLL_MAX_SPEED_PX,
    );
  });

  it("accelerates as the pointer approaches the edge", () => {
    const speeds = [50, 40, 30, 20, 10, 0].map((distance) =>
      dragAutoScrollDelta(END - distance, START, END),
    );
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]).toBeGreaterThanOrEqual(speeds[i - 1]);
    }
    expect(speeds[speeds.length - 1]).toBeGreaterThan(speeds[0]);
  });

  it("never scrolls an axis that cannot scroll", () => {
    expect(dragAutoScrollDelta(0, 100, 100)).toBe(0);
    expect(dragAutoScrollDelta(500, 300, 200)).toBe(0);
  });

  it("picks the nearer edge on a box narrower than two edge zones", () => {
    // 40px wide with a 60px edge zone: every point is inside both bands, so the
    // nearer edge decides — the first half scrolls up/left, the second half
    // scrolls down/right. Neither direction is ever reported for the whole box.
    expect(dragAutoScrollDelta(5, 0, 40)).toBeLessThan(0);
    expect(dragAutoScrollDelta(35, 0, 40)).toBeGreaterThan(0);
  });
});
