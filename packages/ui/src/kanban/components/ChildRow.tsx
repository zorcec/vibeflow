import React from "react";
import type { Task } from "../types";
import { getStatusColor, shortId } from "../task-links";
import { TREE_INDENT_PX } from "./tree-constants";
import { VerifyIndicator, displayedVerifyState } from "./VerifyIndicator";

interface ChildRowProps {
  child: Task;
  onOpen?: () => void;
  variant: "popover" | "detail" | "inline";
  /** Tree depth (1 = direct child). Drives flat left-padding indent per level. */
  depth?: number;
  /** True when the parent link in this child's `links` points at a task not present in allTasks. */
  isOrphan?: boolean;
  /** Direct children count — when > 0 a small ⊃ N chip is shown after the title. */
  childCount?: number;
  /** Callback to remove the parent link for this child. When provided, a hover × Unlink button is rendered. */
  onRemove?: (taskId: string) => void;
  /** Tooltip for the Unlink button. Defaults to the children-tree wording. */
  removeTitle?: string;
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
  removeTitle,
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
  // Verdict to draw, already gated to review/done by the child's own status
  // (see displayedVerifyState). "none" leaves the slot to the status glyph
  // (chevron/dot) or the in-progress loader.
  const verify = displayedVerifyState(child);
  // Flat indent per depth level (no guide lines): the row's own base
  // padding + one TREE_INDENT_PX step per nesting level. The card-zone
  // tree (inline) starts its root level (1 = direct child) at the base
  // padding only — the root pays no step and each level below it pays
  // one. The detail panel keeps the historical root step so its rows
  // stay aligned under the relation-group label (dot + gap = one step).
  const nestingSteps = isInline ? Math.max(guideDepth - 1, 0) : guideDepth;
  const indentPx = (isMinimal ? 2 : 2.5) + nestingSteps * TREE_INDENT_PX;
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
              e.stopPropagation();
              // Register the drag source FIRST — the
              // board latches the dragged id here.
              // dataTransfer is best-effort only (some
              // environments provide none), so it must
              // never be able to abort registration.
              onRowDragStart(e, id);
              try {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", id);
              } catch {
                /* no dataTransfer — the drag session already carries the id */
              }
              // Deferred out of the dragstart dispatch: a DOM write inside it
              // races Chromium's native drag initiation and aborts the
              // session. `currentTarget` is null once the dispatch returns.
              const row = e.currentTarget as HTMLElement;
              setTimeout(() => row.classList.add("dragging"), 0);
            }
          : undefined
      }
      onDragEnd={
        onRowDragStart
          ? (e) => {
              e.currentTarget.classList.remove("dragging");
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
      {/* Leading slot (tree variants): one mark — the in-progress loader,
              the verify verdict, or the status-coloured chevron.
              A verdict can never pair with the loader: it only
              shows in review/done. Popover keeps the dot, upgraded
              to the same verdict glyph. */}
      {isMinimal ? (
        child?.status === "in-progress" ? (
          <span
            className="spinner child-link-spinner"
            role="status"
            aria-label="In progress"
          />
        ) : verify !== "none" ? (
          <VerifyIndicator state={verify} size={10} />
        ) : (
          <span
            className="child-link-chevron"
            aria-hidden="true"
            style={{
              color: getStatusColor(child?.status),
            }}
          >
            ›
          </span>
        )
      ) : verify !== "none" ? (
        <VerifyIndicator state={verify} size={10} />
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
          <span className="child-link-id">{shortId(child?.id ?? "")}</span>
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
      {isOrphan && <span className="child-orphan-label">⚠ missing parent</span>}
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
          title={removeTitle ?? "Unlink from parent"}
          type="button"
        >
          Unlink
        </button>
      )}
    </button>
  );
}
