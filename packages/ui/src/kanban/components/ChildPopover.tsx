import React, { useEffect } from "react";
import ReactDOM from "react-dom";
import type { Task } from "../types";
import { getChildren, computePopoverPosition } from "../task-links";
import { ChildRow } from "./ChildRow";
import {
  requestRelationsScroll,
  relationsScrollEvent,
} from "./detail-panel-scroll";

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

  const visible = children.slice(0, CHILD_POPOVER_MAX_VISIBLE);
  const remaining = children.length - CHILD_POPOVER_MAX_VISIBLE;

  // Estimate what actually renders: at most CHILD_POPOVER_MAX_VISIBLE rows plus the
  // header (and the "+N more" line when truncated), capped by the
  // stylesheet's max-height: 50vh on .child-popover. Estimating from the
  // full child count flips the popover above the chip on a phantom height
  // and pins it to the viewport top, far from the anchor.
  const EST_ROW_H = 28;
  const EST_MORE_H = 22;
  const EST_H = Math.min(
    30 + visible.length * EST_ROW_H + (remaining > 0 ? EST_MORE_H : 0),
    window.innerHeight * 0.5,
  );

  const pos = computePopoverPosition(
    anchorRect,
    EST_H,
    window.innerHeight,
    window.innerWidth,
  );

  const popover = (
    <div
      className="child-popover"
      data-role="child-popover"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: pos.width,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.stopPropagation()}
    >
      <div className="child-popover-header">
        {children.length} child{children.length === 1 ? "" : "ren"}
      </div>
      <div className="child-popover-list">
        {visible.map((child) => (
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
      {remaining > 0 && (
        <button
          type="button"
          className="child-popover-more"
          data-role="child-popover-more"
          aria-label={`Show ${remaining} more children in task details`}
          onClick={(e) => {
            e.stopPropagation();
            // Same open path as every row — the PARENT task in details —
            // then land the fresh panel on the full children list below.
            onOpenTask(task, "details");
            requestRelationsScroll(task.id);
            document.dispatchEvent(relationsScrollEvent(task.id));
          }}
        >
          +{remaining} more
        </button>
      )}
    </div>
  );

  return ReactDOM.createPortal(popover, document.body);
}
