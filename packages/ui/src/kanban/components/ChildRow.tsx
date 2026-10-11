import React from "react";
import type { Task } from "../types";
import { getStatusColor, shortId } from "../task-links";
import { TREE_INDENT_PX } from "./tree-constants";
import { VerifyIndicator, displayedVerifyState } from "./VerifyIndicator";
import { CopyIdButton } from "./CopyIdButton";

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
    // Hover copy-id affordance: same action as the card's CopyIdButton, but
    // only on the board views (inline card-zone tree + children popover).
    // The detail panel keeps its rows unchanged.
    const showCopyId = variant === "inline" || variant === "popover";
    const showActions = (showCopyId && Boolean(child?.id)) || Boolean(onRemove);
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
    // Depth dimming (was a stylesheet opacity ramp on the row root; now inline
    // on the wrapper because the row root is no longer the tree node's direct
    // child): depth 2 = 0.7, depth 3+ = 0.5. Applies only to tree rows —
    // popover rows carry no depth.
    const depthDim =
        depth == null
            ? undefined
            : guideDepth === 2
              ? 0.7
              : guideDepth >= 3
                ? 0.5
                : undefined;
    // Hover/focus state drives the strip lighting (stylesheet-free): the
    // wrapper paints the hover well across row + actions so the copy tab
    // reads as one surface with the row, and Unlink reveals on hover or
    // keyboard focus exactly as it did under the old :hover rules.
    const [wrapHover, setWrapHover] = React.useState(false);
    const [wrapFocus, setWrapFocus] = React.useState(false);
    const [wrapDragging, setWrapDragging] = React.useState(false);
    const [unlinkHover, setUnlinkHover] = React.useState(false);
    const [unlinkFocus, setUnlinkFocus] = React.useState(false);
    const wrapActive = wrapHover || wrapFocus;
    const unlinkLit = unlinkHover || unlinkFocus;
    const unlinkRevealed = wrapActive || unlinkFocus;
    // Structure (be8d59c7): the wrapper's children are the row root and the
    // right-side affordances as SIBLINGS — no interactive element (copy /
    // unlink buttons) nests inside another (neither a native <button> nor
    // the row's div[role=button]). The row root keeps role="button" +
    // tabIndex + Enter/Space handling, whole-row click, and the drag-source
    // hooks; the affordances live in .child-row-actions at the wrapper's
    // right edge. Drag-over/drop intent is classified on the WRAPPER (one
    // handler, wrapper rect) so hovering the actions strip resolves the
    // same row intent instead of falling through to the gap/zone fallback.
    return (
        <div
            className={`child-row-wrap child-row-wrap--${variant}${isOrphan ? " child-row-wrap--orphan" : ""}`}
            data-role="child-row-wrap"
            data-task-id={child?.id}
            data-orphan={isOrphan || undefined}
            style={{
                display: "flex",
                alignItems: "stretch",
                width: "100%",
                borderRadius: 6,
                background: wrapActive ? "var(--t-hover)" : undefined,
                opacity: wrapDragging ? 0.4 : depthDim,
            }}
            onMouseEnter={() => setWrapHover(true)}
            onMouseLeave={() => setWrapHover(false)}
            onFocus={() => setWrapFocus(true)}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setWrapFocus(false);
                }
            }}
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
            <div
                className={`child-link-row child-link-row--${variant}${isOrphan ? " child-row--orphan" : ""}`}
                data-role="child-link-row"
                data-task-id={child?.id}
                data-orphan={isOrphan || undefined}
                role="button"
                tabIndex={0}
                aria-label={`Open child task ${title}`}
                style={{
                    paddingLeft: indentPx,
                    flex: "1 1 auto",
                    width: "auto",
                    minWidth: 0,
                    borderRadius: showActions ? "6px 0 0 6px" : undefined,
                }}
                draggable={draggable || undefined}
                onClick={(e) => {
                    // Genuine bubbling guard (kept): the row sits inside the
                    // card article's onClick — without this a row click opens
                    // the parent card instead of the child.
                    e.stopPropagation();
                    onOpen?.();
                }}
                onKeyDown={(e) => {
                    // Native-button parity: Enter/Space on the row itself
                    // opens the child. The copy/unlink buttons are SIBLINGS
                    // (not descendants), so their own key events never reach
                    // this handler — no guard needed here. preventDefault on
                    // Space stops the page scroll a native button would also
                    // have suppressed.
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpen?.();
                    }
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
                              // Mark the row AND its wrapper so the full-height
                              // actions strip dims with the row.
                              const row = e.currentTarget as HTMLElement;
                              const wrap =
                                  row.closest(".child-row-wrap");
                              setTimeout(() => {
                                  row.classList.add("dragging");
                                  wrap?.classList.add("dragging");
                                  setWrapDragging(true);
                              }, 0);
                          }
                        : undefined
                }
                onDragEnd={
                    onRowDragStart
                        ? (e) => {
                              e.currentTarget.classList.remove("dragging");
                              e.currentTarget
                                  .closest(".child-row-wrap")
                                  ?.classList.remove("dragging");
                              setWrapDragging(false);
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
                {/* Inline (board card tree): title + the child's OWN status badge
              (c8160a0c) — a child in review nested under an in-progress/done
              parent must read as review, not as a plain row of its parent.
              Detail keeps the historical dot + title only. */}
                {isMinimal ? (
                    <span className="child-link-info">
                        <span className="child-link-title">{title}</span>
                        {isInline && (
                            <span
                                className={`status-badge status-badge--${child?.status ?? "todo"}`}
                                data-role="child-status"
                                data-status={child?.status ?? "todo"}
                                title={`Status: ${child?.status ?? "todo"} — nested under its parent card`}
                            >
                                {child?.status ?? "todo"}
                            </span>
                        )}
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
                                // Stable test hook: the nested-child count chip.
                                data-role="child-count"
                                title={`${childCount} direct children`}
                            >
                                ⊃ {childCount}
                            </span>
                        ) : null}
                    </>
                )}
                {isOrphan && (
                    <span className="child-orphan-label">
                        ⚠ missing parent
                    </span>
                )}
            </div>
            {showActions && (
                <div
                    className="child-row-actions"
                    data-role="child-row-actions"
                    style={{
                        display: "flex",
                        alignItems: "stretch",
                        flexShrink: 0,
                        marginLeft: "auto",
                        marginTop: 1,
                        marginBottom: 1,
                        borderLeft:
                            "1px solid color-mix(in srgb, var(--t-border) 70%, transparent)",
                        borderRadius: "0 6px 6px 0",
                    }}
                >
                    {showCopyId && child?.id && (
                        <CopyIdButton
                            taskId={child.id}
                            className="card-copy-id--child"
                            edge
                            edgeEnd={!onRemove}
                        />
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
                            onMouseDown={(e) => e.stopPropagation()}
                            onMouseEnter={() => setUnlinkHover(true)}
                            onMouseLeave={() => setUnlinkHover(false)}
                            onFocus={() => setUnlinkFocus(true)}
                            onBlur={() => setUnlinkFocus(false)}
                            title={removeTitle ?? "Unlink from parent"}
                            aria-label={`Unlink child task ${title} from parent`}
                            type="button"
                            style={{
                                alignSelf: "stretch",
                                display: "inline-flex",
                                alignItems: "center",
                                padding: "0 10px",
                                border: "none",
                                borderLeft:
                                    showCopyId && child?.id
                                        ? "1px solid color-mix(in srgb, var(--t-border) 60%, transparent)"
                                        : "none",
                                borderRadius: "0 6px 6px 0",
                                background: unlinkLit
                                    ? "color-mix(in srgb, var(--t-danger) 12%, transparent)"
                                    : "transparent",
                                color: unlinkLit
                                    ? "var(--t-danger)"
                                    : "var(--t-text-faint)",
                                opacity: unlinkRevealed ? 1 : 0,
                                pointerEvents: unlinkRevealed
                                    ? "auto"
                                    : "none",
                                outline: unlinkFocus
                                    ? "2px solid color-mix(in srgb, var(--t-danger) 55%, transparent)"
                                    : "none",
                                outlineOffset: -2,
                                transition:
                                    "opacity 0.12s ease, color 0.1s ease, background 0.1s ease",
                            }}
                        >
                            Unlink
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
