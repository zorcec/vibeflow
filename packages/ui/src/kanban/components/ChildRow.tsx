import React from "react";
import type { Task } from "../types";
import { getStatusColor, shortId } from "../task-links";

interface ChildRowProps {
    child: Task;
    onOpen?: () => void;
    variant: "popover" | "detail" | "inline";
    /** Tree depth (1 = direct child). Drives flat left-padding indent per level. */
    depth?: number;
    /** Unused legacy prop (kept for API compatibility) — guide elbows were removed. */
    isLast?: boolean;
    /** True when the parent link in this child's `links` points at a task not present in allTasks. */
    isOrphan?: boolean;
    /** Direct children count — when > 0 a small ⊃ N chip is shown after the title. */
    childCount?: number;
    /** Callback to remove the parent link for this child. When provided, a hover × Remove button is rendered. */
    onRemove?: (taskId: string) => void;
    /** Drag source id — when provided the row is draggable (tree variants). Popover rows omit this. */
    onRowDragStart?: (e: React.DragEvent, childId: string) => void;
    /** Fired on dragover of the row — the tree classifies the tree-row intent. */
    onRowDragOver?: (e: React.DragEvent, childId: string) => void;
    /** Fired on drop of the row — bubbles to the column/section drop handler. */
    onRowDrop?: (e: React.DragEvent, childId: string) => void;
}

export function ChildRow({
    child,
    onOpen,
    variant,
    depth,
    isOrphan,
    childCount,
    onRemove,
    onRowDragStart,
    onRowDragOver,
    onRowDrop,
}: ChildRowProps) {
    const isInline = variant === "inline";
    const isMinimal = variant === "inline" || variant === "detail";
    const guideDepth = depth ?? 0;
    const isHollow = guideDepth >= 2;
    const draggable = Boolean(onRowDragStart) && Boolean(child?.id);
    const title = child?.title ?? "(untitled)";
    // Flat indent per depth level (no guide lines): base row padding +
    // one 14px slot per level so hierarchy still reads. Slot width must
    // stay in sync with TREE_INDENT_PX (14).
    const indentPx = (isMinimal ? 4 : 5) + guideDepth * 14;
    return (
        <button
            className={`child-link-row child-link-row--${variant}${isOrphan ? " child-row--orphan" : ""}`}
            data-role="child-link-row"
            data-task-id={child?.id}
            data-orphan={isOrphan || undefined}
            type="button"
            style={{ paddingLeft: indentPx }}
            draggable={draggable || undefined}
            onClick={(e) => {
                e.stopPropagation();
                onOpen?.();
            }}
            onDragStart={
                onRowDragStart
                    ? (e) => {
                          const id = child?.id;
                          if (!id) return;
                          e.dataTransfer.effectAllowed = "move";
                          try {
                              e.dataTransfer.setData("text/plain", id);
                          } catch {
                              /* setData may throw in some test environments — id travels via dragSession */
                          }
                          e.stopPropagation();
                          onRowDragStart(e, id);
                      }
                    : undefined
            }
            onDragOver={
                onRowDragOver
                    ? (e) => {
                          // Prevent the board handleCardDragOver from overwriting the tree intent.
                          e.preventDefault();
                          e.stopPropagation();
                          const id = child?.id;
                          if (!id) return;
                          onRowDragOver(e, id);
                      }
                    : undefined
            }
            onDrop={
                onRowDrop
                    ? (e) => {
                          e.preventDefault();
                          const id = child?.id;
                          if (!id) return;
                          onRowDrop(e, id);
                      }
                    : undefined
            }
        >
            {/* Chevron on spine (tree variants) — status-colored, in-flow.
                            Popover keeps the legacy dot below. */}
            {isMinimal ? (
                <span
                    className="child-link-chevron"
                    aria-hidden="true"
                    style={{
                        color: getStatusColor(child?.status),
                    }}
                >
                    ›
                </span>
            ) : (
                <span
                    className={`child-link-dot child-link-dot--on-line${isHollow ? " child-link-dot--hollow" : ""}`}
                    style={{
                        backgroundColor: isHollow
                            ? undefined
                            : getStatusColor(child?.status),
                    }}
                />
            )}
            {/* Inline + detail: dot + title only — matches proposal design (detail uses same minimal rows) */}
            {isMinimal ? (
                <span className="child-link-info">
                    <span className="child-link-title">{title}</span>
                </span>
            ) : (
                <>
                    <span className="child-link-id">
                        {shortId(child?.id ?? "")}
                    </span>
                    <span className="child-link-info">
                        <span className="child-link-title">{title}</span>
                        <span
                            className={`status-badge status-badge--${child?.status ?? "todo"}`}
                        >
                            {child?.status ?? "todo"}
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
            {isOrphan && (
                <span className="child-orphan-label">⚠ missing parent</span>
            )}
            {onRemove && (
                <button
                    className="relation-remove"
                    draggable={false}
                    onClick={(e) => {
                        e.stopPropagation();
                        const id = child?.id;
                        if (!id) return;
                        onRemove(id);
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
