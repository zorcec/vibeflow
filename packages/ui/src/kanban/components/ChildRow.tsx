import React from "react";
import type { Task } from "../types";
import { getStatusColor, shortId } from "../task-links";

interface ChildRowProps {
  child: Task;
  onOpen?: () => void;
  variant: "popover" | "detail" | "inline";
  /** Tree depth (1 = direct child). Drives indent-guide count + hollow dot class for depth 2+. */
  depth?: number;
  /** True when this is the last sibling — the own-level guide draws an elbow. */
  isLast?: boolean;
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
  isLast,
  isOrphan,
  childCount,
  onRemove,
}: ChildRowProps) {
  const isInline = variant === "inline";
  const isMinimal = variant === "inline" || variant === "detail";
  const guideDepth = depth ?? 0;
  const isHollow = guideDepth >= 2;
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
      {/* VS Code-style indent guides — one 14px slot per depth level.
                            Middle levels always draw full height; only the row's own
                            level draws an elbow when it is the last sibling. */}
      {guideDepth > 0 && (
        <span className="tree-guides" aria-hidden="true">
          {Array.from({
            length: guideDepth,
          }).map((_, i) => (
            <span
              key={i}
              className={
                i === guideDepth - 1 && isLast
                  ? "tree-guide--last"
                  : "tree-guide"
              }
            />
          ))}
        </span>
      )}
      {/* Dot on spine — hollow class toggled by depth */}
      <span
        className={`child-link-dot child-link-dot--on-line${isHollow ? " child-link-dot--hollow" : ""}`}
        style={{
          backgroundColor: isHollow ? undefined : getStatusColor(child.status),
        }}
      />
      {/* Inline + detail: dot + title only — matches proposal design (detail uses same minimal rows) */}
      {isMinimal ? (
        <span className="child-link-info">
          <span className="child-link-title">{child.title}</span>
        </span>
      ) : (
        <>
          <span className="child-link-id">{shortId(child.id)}</span>
          <span className="child-link-info">
            <span className="child-link-title">{child.title}</span>
            <span
              className={`status-badge status-badge--${child.status ?? "todo"}`}
            >
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
        </>
      )}
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
