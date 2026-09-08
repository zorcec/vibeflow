import React, { useEffect } from "react";
import ReactDOM from "react-dom";
import type { Task } from "../types";
import { getChildren, computePopoverPosition } from "../task-links";
import { ChildRow } from "./ChildRow";

interface ChildPopoverProps {
  task: Task;
  allTasks: Task[];
  onOpenTask: (task: Task) => void;
  anchorRect?: DOMRect | null;
}

const MAX_VISIBLE = 6;

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

  const visible = children.slice(0, MAX_VISIBLE);
  const remaining = children.length - MAX_VISIBLE;

  const EST_ROW_H = 28;
  const EST_H = 30 + children.length * EST_ROW_H;

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
            onOpen={() => {
              onOpenTask(child);
            }}
          />
        ))}
      </div>
      {remaining > 0 && (
        <div className="child-popover-more">…and {remaining} more</div>
      )}
    </div>
  );

  return ReactDOM.createPortal(popover, document.body);
}
