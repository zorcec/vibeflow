import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import type { Task } from "../types";
import { getChildren, computePopoverPosition } from "../task-links";
import { ChildRow } from "./ChildRow";

interface ChildPopoverProps {
  task: Task;
  allTasks: Task[];
  /**
   * Tab target rides along (round 2): the attention bell asks for
     `"comments"`, the row body asks for nothing — one open path.
   */
  onOpenTask: (task: Task, tab?: "details" | "comments" | "files") => void;
  anchorRect?: DOMRect | null;
}

/** How many child rows the hover popover renders before truncating with a
 *  "+N more" affordance. Raised from 6 so mid-size families read at a glance;
 *  the popover still clamps to 50vh and the row list scrolls internally. */
export const CHILD_POPOVER_MAX_VISIBLE = 30;

export default function ChildPopover({
  task,
  allTasks,
  onOpenTask,
  anchorRect,
}: ChildPopoverProps) {
  const children = getChildren(allTasks, task.id);

  // ── Hooks MUST be called before any early returns (rules of hooks) ──

  // Close on scroll or resize to prevent detached popover (S5: merged)
  useEffect(() => {
    if (!anchorRect) return;
    const close = () => {
      document.dispatchEvent(new CustomEvent("child-popover-close"));
    };
    window.addEventListener("scroll", close, { capture: true, once: true });
    window.addEventListener("resize", close, { once: true });
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [anchorRect]);

  // ── Early returns (after all hooks) ──

  if (children.length === 0) return null;
  if (!anchorRect) return null;

  // EVERY child renders; there is no truncation and no "+N more" affordance
  // (owner decision 2026-11-10). A big family is handled by the list's own
  // max-height + scroll, so nothing is ever silently hidden behind a button.
  const EST_ROW_H = 28;
  const VISIBLE_ROWS = 30; // the list's height budget, in whole rows
  // Same budget as the stylesheet's `max-height: calc(100vh - 24px)` — the
  // estimator must describe what actually renders, or the popover flips/hides
  // on a phantom height (ticket a0919c04).
  const EST_H = Math.min(
    30 + Math.min(children.length, VISIBLE_ROWS) * EST_ROW_H,
    window.innerHeight - 24,
  );

  const pos = computePopoverPosition(
    anchorRect,
    EST_H,
    window.innerHeight,
    window.innerWidth,
  );

  // Height that ends exactly on a row boundary, MEASURED rather than derived
  // from constants: the assumptions (28px rows, 30px header) are estimates and
  // a 4px error still sliced the last row in half — which is what the owner
  // reported as "cut off" (ticket a0919c04). One layout pass, then snapped.
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [snappedMaxHeight, setSnappedMaxHeight] = useState<number | null>(null);
  // Measure ONCE, from the un-snapped box. Re-running this after applying the
  // snap would measure the already-shrunk popover and walk the height down
  // every pass (observed: 768px -> 168px).
  useLayoutEffect(() => {
    if (snappedMaxHeight !== null) return;
    const el = popoverRef.current;
    if (!el) return;
    const list = el.querySelector<HTMLElement>(".child-popover-list");
    const firstRow = list?.querySelector<HTMLElement>(
      "[data-role='child-row-wrap']",
    );
    if (!list || !firstRow) return;
    const rowH = firstRow.getBoundingClientRect().height;
    if (!(rowH > 0)) return;
    // Chrome measured from the NATURAL box (the first layout pass sets no
    // maxHeight): header + affordance + padding + borders, exactly.
    const chrome =
      el.getBoundingClientRect().height - list.getBoundingClientRect().height;
    const available = pos.maxHeight - chrome;
    if (available <= 0) return;
    // Snap to the MEASURED bottom of the last row that fits. Arithmetic on an
    // assumed row pitch left a sub-pixel sliver of the next row at the edge,
    // which is precisely the "cut off" the owner reported.
    const listTop = list.getBoundingClientRect().top;
    let cut = 0;
    for (const row of Array.from(
      list.querySelectorAll<HTMLElement>("[data-role='child-row-wrap']"),
    )) {
      const box = row.getBoundingClientRect();
      const bottom = box.bottom - listTop;
      if (bottom > available + 0.5) break;
      cut = bottom;
    }
    if (cut <= 0) return;
    setSnappedMaxHeight(chrome + cut);
    // NO dependency array on purpose: the popover is portalled, so the first
    // layout pass can run before the node is attached. With deps, the effect
    // never re-ran and the snap silently never applied (the height stayed at
    // the un-snapped fallback). The `snappedMaxHeight !== null` guard at the
    // top stops it from looping.
  });

  const popover = (
    <div
      className="child-popover"
      ref={popoverRef}
      data-role="child-popover"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: pos.width,
        // The positioner owns the height: only it knows how much room the
        // chosen side has, and a popover that covered its own chip would
        // swallow the hover that opened it (ticket a0919c04).
        //
        // SNAPPED to whole rows: a budget of 768px over 772px of content left
        // the 28th row sliced in half at the popover edge, which reads as "the
        // children are cut off" even though the row is scrollable into view.
        // Showing one row fewer is honest; showing half a row is not.
        maxHeight: snappedMaxHeight ?? pos.maxHeight,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.stopPropagation()}
    >
      <div className="child-popover-header">
        {children.length} child{children.length === 1 ? "" : "ren"}
      </div>
      <div className="child-popover-list">
        {children.map((child) => (
          <ChildRow
            key={child.id}
            child={child}
            variant="popover"
            onOpen={(tab) => {
              onOpenTask(child, tab);
            }}
          />
        ))}
      </div>
    </div>
  );

  return ReactDOM.createPortal(popover, document.body);
}
