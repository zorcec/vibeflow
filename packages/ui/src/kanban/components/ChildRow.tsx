import React from "react";
import type { Task } from "../types";
import { getStatusColor, shortId } from "../task-links";

interface ChildRowProps {
  child: Task;
  onOpen?: () => void;
  variant: "popover" | "detail" | "inline";
  /** Tree depth (1 = direct child). Used to toggle hollow dot class for depth 2+. */
  depth?: number;
  /** True when the parent link in this child's `links` points at a task not present in allTasks. */
  isOrphan?: boolean;
  /** Direct children count — when > 0 a small ⊃ N chip is shown after the title. */
  childCount?: number;
  /** Callback to remove the parent link for this child. When provided, a hover × Remove button is rendered. */
  onRemove?: (taskId: string) => void;
}

export function ChildRow({
  child,
  onOpen,
  variant,
  depth,
  isOrphan,
  childCount,
  onRemove,
}: ChildRowProps) {
  const isInline = variant === "inline";
  const isHollow = (depth ?? 1) >= 2;
  return (
    <button
      className={`child-link-row child-link-row--${variant}${isOrphan ? " child-row--orphan" : ""}`}
      data-role="child-link-row"
      data-orphan={isOrphan || undefined}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.();
      }}
    >
      {/* Dot on spine — hollow class toggled by depth */}
      <span
        className={`child-link-dot child-link-dot--on-line${isHollow ? " child-link-dot--hollow" : ""}`}
        style={{
          backgroundColor: isHollow ? undefined : getStatusColor(child.status),
        }}
      />
      <span className="child-link-id">{shortId(child.id)}</span>
      <span className="child-link-info">
        <span className="child-link-title">{child.title}</span>
        <span className={`status-badge status-badge--${child.status ?? "todo"}`}>
          {child.status ?? "todo"}
        </span>
      </span>
      {childCount && childCount > 0 ? (
        <span
          className="parent-count-chip"
          title={`${childCount} direct children`}
        >
          ⊃ {childCount}
        </span>
      ) : null}
      {isOrphan && <span className="child-orphan-label">⚠ missing parent</span>}
      {onRemove && (
        <button
          className="relation-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(child.id);
          }}
          title="Remove link"
          type="button"
        >
          Remove
        </button>
      )}
    </button>
  );
}
