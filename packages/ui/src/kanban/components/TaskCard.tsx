import React from "react";
import ReactDOM from "react-dom";
import { MessageCircle, Paperclip, ChevronDown } from "lucide-react";
import { CopyIdButton } from "./CopyIdButton";
import type { Task, Column, LiveActivity } from "../types";
import { isNewComments } from "../utils";
import { TypeBadge } from "../../TypeBadge";
import { PriorityBadge } from "../../PriorityBadge";
import { getTaskTypeColor } from "../../task-types";
import { TagPills } from "./shared/TagPills";
import {
      getBlockers,
      getChildren,
      getDescendants,
      getLeafDescendants,
} from "../task-links";
import { RecursiveChildrenTree } from "./RecursiveChildrenTree";
import ChildPopover from "./ChildPopover";
import { displayedVerifyState } from "./VerifyIndicator";
import { presenceAreaLabel, presenceChipFill, presenceInitials } from "./shared/presence";
import { LeadingSlot } from "./TaskCardLeadingSlot";

interface Props {
      task: Task;
      col: Column;
      liveActivity?: LiveActivity;
      compact?: boolean;
      allTasks: Task[];
      onOpen: (task: Task, tab?: "details" | "comments" | "files") => void;
      onOpenTask?: (task: Task) => void;
      /** Called when a child row inside the card is clicked (opens child in detail panel). */
      onOpenChild?: (task: Task) => void;
      onDragStart: (e: React.DragEvent, taskId: string) => void;
      /** When a drag is over this card's children zone, forward the event. */
      onChildrenZoneDragOver?: (e: React.DragEvent) => void;
      /** When a drag leaves this card's children zone, forward the event. */
      onChildrenZoneDragLeave?: (e: React.DragEvent) => void;
      /** Tree-row intent — same single ref as the board, forwarded to the card tree. */
      treeIntent?: import("../task-links").DropIntent | null;
      onTreeIntent?: (
            intent: import("../task-links").DropIntent | null,
      ) => void;
      /** Row dragstart mirror — sets the board drag source for tree-row drags. */
      onTreeRowDragStart?: (e: React.DragEvent, childId: string) => void;
      /** Called when the user clicks Unlink on a child row in the card's inline tree. */
      onDetach?: (taskId: string) => void;
      /** Reactive drag-active flag — forwarded to RecursiveChildrenTree for empty-slot visibility. */
      isDragging?: boolean;
      /** Current user's id — drives the per-user unread dot and inline expanded state. */
      currentUserId?: string;
      /** Persists the current user's expand/collapse choice for this card. */
      onToggleExpanded?: (taskId: string, expanded: boolean) => void;
      /**
       * Whether this card's lane reserves the leading slot's width — the
       * lane-level answer from `laneReservesLeadingSlot`. Defaults to true, so a
       * caller that does not know its lane keeps the b0545910 alignment.
       */
      reserveLeadingSlot?: boolean;
}

function isImageFileName(name: string): boolean {
      return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name);
}

function withHexAlpha(hexColor: string, alpha: number): string | undefined {
      if (!/^#[0-9a-fA-F]{6}$/.test(hexColor)) return undefined;
      const normalized = Math.max(0, Math.min(1, alpha));
      const alphaHex = Math.round(normalized * 255)
            .toString(16)
            .padStart(2, "0");
      return `${hexColor}${alphaHex}`;
}

export function resolveTaskCardBorderColor(
      statusColor: string,
      priority?: Task["priority"],
): string {
      const alpha =
            priority === "Critical" ? 0.36 : priority === "High" ? 0.3 : 0.24;
      return (
            withHexAlpha(statusColor, alpha) ??
            "color-mix(in srgb, var(--t-text-ghost) 40%, transparent)"
      );
}

export function resolveTaskCardBgColor(typeColor: string): string {
      return withHexAlpha(typeColor, 0.1) ?? "transparent";
}

// ── Static styles extracted to avoid per-render object allocation ──────────

const DONE_ARTICLE_STYLE: React.CSSProperties = {
      padding: "7px 8px",
      gap: 4,
      opacity: 1,
      userSelect: "none",
};
const DONE_INNER_ROW_STYLE: React.CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: 5,
};
const DONE_TITLE_STYLE: React.CSSProperties = {
      fontSize: 11.5,
      fontWeight: 600,
      color: "var(--t-text-muted)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      flex: 1,
};
const CARD_TITLE_ROW_STYLE: React.CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: 5,
      minWidth: 0,
};
const CARD_TITLE_TEXT_STYLE: React.CSSProperties = {
      fontSize: 11.5,
      fontWeight: 600,
      color: "var(--t-text)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      flex: 1,
};
const DESC_THUMB_ROW_STYLE: React.CSSProperties = {
      display: "flex",
      alignItems: "flex-start",
      gap: 8,
};
const DESC_TEXT_STYLE: React.CSSProperties = {
      fontSize: 10,
      color: "var(--t-text-body)",
      lineHeight: "1.45",
      overflow: "hidden",
      display: "-webkit-box",
      WebkitBoxOrient: "vertical",
      WebkitLineClamp: 2,
      flex: 1,
      minWidth: 0,
} as React.CSSProperties;
const THUMB_WRAPPER_STYLE: React.CSSProperties = {
      position: "relative",
      flexShrink: 0,
};
const THUMB_IMG_STYLE: React.CSSProperties = {
      width: 52,
      height: 34,
      borderRadius: 6,
      objectFit: "cover",
      border: "1px solid color-mix(in srgb, var(--t-border) 90%, transparent)",
      display: "block",
      cursor: "pointer",
};
const CARD_FOOTER_STYLE: React.CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: 2,
      marginTop: 1,
      // The badge cluster owns no growth and shrinks to zero, but only if
      // the footer itself can shrink — without minWidth 0 a wide badge
      // (0bc9922f) pushes the comment/file/children actions out of view.
      minWidth: 0,
      flexWrap: "nowrap",
};
// Compact title-row indicators (file / children / messages, 0a2fa3d6): the
// normal card's footer icons moved inline with the title. Rendered only
// when nonzero so an empty card stays a clean 1:1 title clone; each opens
// the same tab the footer button would (children opens the task, whose
// tree lives in the panel — a single row cannot expand inline).
const COMPACT_INDICATOR_STYLE: React.CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      gap: 2,
      padding: "1px 3px",
      borderRadius: 3,
      border: "none",
      background: "transparent",
      cursor: "pointer",
      fontSize: 9,
      fontWeight: 600,
      color: "var(--t-text-muted)",
      flexShrink: 0,
};
const SPACER_STYLE: React.CSSProperties = { flex: 1 };

export const TaskCard = React.memo(function TaskCard({
      task,
      col,
      liveActivity,
      compact,
      allTasks,
      onOpen,
      onOpenTask,
      onOpenChild,
      onDragStart,
      onChildrenZoneDragOver,
      onChildrenZoneDragLeave,
      treeIntent,
      onTreeIntent,
      onTreeRowDragStart,
      onDetach,
      isDragging,
      currentUserId,
      onToggleExpanded,
      reserveLeadingSlot,
}: Props) {
      const isInProgress = col.id === "in-progress";
      const isDone = col.id === "done";
      // Verdict to draw, already gated to the review/done lanes by
      // displayedVerifyState. "none" leaves the slot to the status glyphs.
      const verify = displayedVerifyState(task);
      // Unknown viewer id → cannot tell if the task was opened, so never claim
      // unread. Read by the leading slot in both branches.
      const isUnread =
            !!currentUserId && !(task.openedBy ?? []).includes(currentUserId);
      const [showThumbPreview, setShowThumbPreview] = React.useState(false);
      const [thumbRect, setThumbRect] = React.useState<{
            top: number;
            right: number;
      } | null>(null);
      const [showChildPopover, setShowChildPopover] = React.useState(false);
      const [childChipRect, setChildChipRect] = React.useState<DOMRect | null>(
            null,
      );
      // Expanded state is per user and persisted on the task (expandedBy) — not
      // in-memory, so it survives a reload.
      const expanded =
            !!currentUserId && (task.expandedBy ?? []).includes(currentUserId);
      const thumbRef = React.useRef<HTMLImageElement>(null);
      const childChipRef = React.useRef<HTMLSpanElement>(null);
      const childHoverTimeout = React.useRef<ReturnType<
            typeof setTimeout
      > | null>(null);

      const directChildren = getChildren(allTasks, task.id);
      const childCount = directChildren.length;

      // Listen for scroll-close signal from ChildPopover
      React.useEffect(() => {
            const handler = () => {
                  setShowChildPopover(false);
            };
            document.addEventListener("child-popover-close", handler);
            return () =>
                  document.removeEventListener("child-popover-close", handler);
      }, []);

      const commentCount = task.commentCount ?? 0;
      const fileCount = task.fileCount ?? 0;
      const hasNewComments =
            commentCount > 0 && isNewComments(task.id, commentCount);

      const cardBorderColor = resolveTaskCardBorderColor(
            col.color,
            task.priority,
      );
      const typeColor = getTaskTypeColor(task.type);
      const cardBgColor = resolveTaskCardBgColor(typeColor);
      const firstImage = task.files?.find((f) => isImageFileName(f.name));
      const thumbnailUrl = firstImage
            ? `/api/tasks/${task.id}/files/${encodeURIComponent(firstImage.name)}`
            : null;

      function handleDragStart(e: React.DragEvent) {
            // Capture the element before the dispatch returns — React nulls
            // `currentTarget` once it does.
            const card = e.currentTarget as HTMLElement;
            onDragStart(e, task.id);
            // Deferred out of the dragstart dispatch: a DOM write inside it
            // races Chromium's native drag initiation and aborts the session.
            setTimeout(() => card.classList.add("dragging"), 0);
      }

      function handleDragEnd(e: React.DragEvent) {
            e.currentTarget.classList.remove("dragging");
      }

      function handleClick() {
            onOpen(task);
      }

      function toggleExpanded(next: boolean) {
            setShowChildPopover(false);
            onToggleExpanded?.(task.id, next);
      }

      // Compact view (any lane) or done column: single-row card.
      // Done cards stay title-only; compact cards additionally inline the
      // nonzero file / children / message indicators with the title
      // (0a2fa3d6) — no description, no badges either way. Compact cards
      // carry no copy-ID button: its 22px box was reserved even while
      // invisible (opacity 0), stealing title width for no affordance.
      const showInlineIcons = !!compact && !isDone;
      if (compact || isDone) {
            return (
                  <article
                        className="task-card"
                        draggable
                        // Stable test hook. The e2e parent-links suite waits on
                        // `[data-role="task-card"]`; without it the wait timed
                        // out on a board that was rendering perfectly well.
                        data-role="task-card"
                        data-task-id={task.id}
                        data-compact={compact ? "true" : undefined}
                        style={{
                              ...DONE_ARTICLE_STYLE,
                        }}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        onClick={handleClick}
                  >
                        <div style={DONE_INNER_ROW_STYLE}>
                              <LeadingSlot
                                    layout="row"
                                    columnId={col.id}
                                    verify={verify}
                                    isInProgress={isInProgress}
                                    isDone={isDone}
                                    isUnread={isUnread}
                                    reserve={reserveLeadingSlot}
                              />
                              <span
                                    data-role="card-title"
                                    style={{
                                          ...DONE_TITLE_STYLE,
                                          ...(isDone
                                                ? {}
                                                : { color: "var(--t-text)" }),
                                    }}
                              >
                                    {task.title}
                              </span>
                              {showInlineIcons && commentCount > 0 && (
                                    <button
                                          data-role="compact-comment-count"
                                          title={`${commentCount} comment(s)`}
                                          style={COMPACT_INDICATOR_STYLE}
                                          onClick={(e) => {
                                                e.stopPropagation();
                                                onOpen(task, "comments");
                                          }}
                                    >
                                          <MessageCircle
                                                style={{ width: 9, height: 9 }}
                                          />
                                          {commentCount}
                                    </button>
                              )}
                              {showInlineIcons && fileCount > 0 && (
                                    <button
                                          data-role="compact-file-count"
                                          title={`${fileCount} file(s) attached`}
                                          style={COMPACT_INDICATOR_STYLE}
                                          onClick={(e) => {
                                                e.stopPropagation();
                                                onOpen(task, "files");
                                          }}
                                    >
                                          <Paperclip
                                                style={{ width: 9, height: 9 }}
                                          />
                                          {fileCount}
                                    </button>
                              )}
                              {showInlineIcons && childCount > 0 && (
                                    <button
                                          data-role="compact-child-count"
                                          title={`${childCount} subtask(s) — open task`}
                                          style={COMPACT_INDICATOR_STYLE}
                                          onClick={(e) => {
                                                e.stopPropagation();
                                                onOpen(task);
                                          }}
                                    >
                                          <span>⤷</span>
                                          {childCount}
                                    </button>
                              )}
                              {/* No CopyIdButton in compact view (owner call 0a2fa3d6):
                                  the pill keeps its 22px box while invisible. Done-lane
                                  cards in board view keep theirs. */}
                              {!compact && <CopyIdButton taskId={task.id} />}
                        </div>
                  </article>
            );
      }
      const blockers = getBlockers(allTasks, task.id);
      return (
            <article
                  className={`task-card${liveActivity ? " task-live-edit" : ""}`}
                  draggable
                  data-role="task-card"
                  data-task-id={task.id}
                  data-blocked={blockers.length > 0 ? "true" : undefined}
                  title={
                        blockers.length > 0
                              ? `Blocked by: ${blockers
                                      .map((b) => b?.title ?? "Untitled")
                                      .join(", ")}`
                              : undefined
                  }
                  style={{
                        padding: "7px 8px",
                        gap: 4,
                        userSelect: "none",
                        position: "relative",
                        background: liveActivity
                              ? "rgba(59,130,246,0.08)"
                              : cardBgColor,
                        border: liveActivity
                              ? "1px solid rgba(59,130,246,0.5)"
                              : cardBorderColor
                                ? `1px solid ${cardBorderColor}`
                                : undefined,
                        ...(blockers.length > 0 || liveActivity
                              ? {
                                      boxShadow: [
                                            blockers.length > 0
                                                  ? "inset 3px 0 0 0 var(--t-danger)"
                                                  : null,
                                            liveActivity
                                                  ? "0 0 0 2px rgba(59,130,246,0.14)"
                                                  : null,
                                      ]
                                            .filter(Boolean)
                                            .join(", "),
                                }
                              : {}),
                  }}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onClick={handleClick}
            >
                  {/* Row 1: title [screenshot-thumb] */}
                  <div style={CARD_TITLE_ROW_STYLE}>
                        <LeadingSlot
                              layout="card"
                              columnId={col.id}
                              verify={verify}
                              isInProgress={isInProgress}
                              isDone={isDone}
                              isUnread={isUnread}
                              reserve={reserveLeadingSlot}
                        />
                        <span
                              data-role="card-title"
                              style={CARD_TITLE_TEXT_STYLE}
                        >
                              {task.title}
                        </span>
                        <CopyIdButton taskId={task.id} />
                  </div>

                  {/* Description + screenshot thumbnail */}
                  {(task.description || thumbnailUrl) && (
                        <div style={DESC_THUMB_ROW_STYLE}>
                              {task.description && (
                                    <div style={DESC_TEXT_STYLE}>
                                          {task.description}
                                    </div>
                              )}
                              {thumbnailUrl && (
                                    <div
                                          style={THUMB_WRAPPER_STYLE}
                                          onMouseEnter={() => {
                                                if (thumbRef.current) {
                                                      const r =
                                                            thumbRef.current.getBoundingClientRect();
                                                      setThumbRect({
                                                            top: r.top,
                                                            right: r.right,
                                                      });
                                                }
                                                setShowThumbPreview(true);
                                          }}
                                          onMouseLeave={() => {
                                                setShowThumbPreview(false);
                                                setThumbRect(null);
                                          }}
                                    >
                                          <img
                                                ref={thumbRef}
                                                src={thumbnailUrl}
                                                alt="Task screenshot"
                                                data-role="task-thumb"
                                                style={THUMB_IMG_STYLE}
                                          />
                                          {showThumbPreview &&
                                                thumbRect &&
                                                ReactDOM.createPortal(
                                                      <img
                                                            src={thumbnailUrl}
                                                            alt="Task screenshot enlarged preview"
                                                            data-role="task-thumb-preview"
                                                            style={{
                                                                  position: "fixed",
                                                                  right:
                                                                        window.innerWidth -
                                                                        thumbRect.right,
                                                                  bottom:
                                                                        window.innerHeight -
                                                                        thumbRect.top +
                                                                        8,
                                                                  width: 220,
                                                                  height: 138,
                                                                  borderRadius: 8,
                                                                  objectFit:
                                                                        "cover",
                                                                  border: "1px solid color-mix(in srgb, var(--t-border) 96%, transparent)",
                                                                  boxShadow:
                                                                        "0 10px 24px color-mix(in srgb, var(--t-bg) 75%, transparent)",
                                                                  pointerEvents:
                                                                        "none",
                                                                  zIndex: 9999,
                                                                  background:
                                                                        "var(--t-bg)",
                                                            }}
                                                      />,
                                                      document.body,
                                                )}
                                    </div>
                              )}
                        </div>
                  )}

                  {/* Footer: TypeBadge + PriorityBadge + Assignee + tags + spacer + action buttons */}
                  <div className="flex items-center" style={CARD_FOOTER_STYLE}>
                        <TypeBadge type={task.type} />
                        {task.priority && (
                              <PriorityBadge priority={task.priority} />
                        )}
                        {isInProgress && task.assigneeName && (
                              <span
                                    style={{
                                          fontSize: 10,
                                          fontWeight: 600,
                                          padding: "1px 6px",
                                          borderRadius: 6,
                                          background: "rgba(59,130,246,0.12)",
                                          color: "var(--t-accent-soft)",
                                          whiteSpace: "nowrap",
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          maxWidth: 80,
                                    }}
                              >
                                    {task.assigneeName}
                              </span>
                        )}
                        {task.tags && task.tags.length > 0 && (
                              <TagPills tags={task.tags} size="xs" />
                        )}
                        <div style={SPACER_STYLE} />
                        {liveActivity && (
                              <LiveActivityBadge activities={[liveActivity]} />
                        )}
                        <CardIconButton
                              icon={
                                    <MessageCircle
                                          style={{ width: 9, height: 9 }}
                                    />
                              }
                              label={
                                    commentCount > 0 ? String(commentCount) : ""
                              }
                              color={
                                    hasNewComments
                                          ? "var(--t-secondary)"
                                          : commentCount > 0
                                            ? "var(--t-text-muted)"
                                            : "var(--t-border-faint)"
                              }
                              hoverColor={
                                    hasNewComments
                                          ? "var(--t-secondary-soft)"
                                          : "var(--t-text)"
                              }
                              title={
                                    commentCount > 0
                                          ? `${commentCount} comment(s)`
                                          : "Add comment"
                              }
                              badge={hasNewComments}
                              badgeColor="var(--t-secondary)"
                              onClick={(e) => {
                                    e.stopPropagation();
                                    onOpen(task, "comments");
                              }}
                        />
                        <CardIconButton
                              icon={
                                    <Paperclip
                                          style={{ width: 9, height: 9 }}
                                    />
                              }
                              label={fileCount > 0 ? String(fileCount) : ""}
                              color={
                                    fileCount > 0
                                          ? "var(--t-accent-soft)"
                                          : "var(--t-border-faint)"
                              }
                              hoverColor={
                                    fileCount > 0
                                          ? "var(--t-cyan-soft)"
                                          : "var(--t-text-sub)"
                              }
                              title={
                                    fileCount > 0
                                          ? `${fileCount} file(s) attached`
                                          : "Files"
                              }
                              onClick={(e) => {
                                    e.stopPropagation();
                                    onOpen(task, "files");
                              }}
                        />
                        {childCount > 0 && (
                              <span
                                    ref={childChipRef}
                                    role="button"
                                    tabIndex={0}
                                    className="child-toggle-chip"
                                    // Two hooks on purpose: `children-toggle` is
                                    // the action, `child-chip` is the visual
                                    // chip. Specs that assert "the chip shows N"
                                    // should not have to know it is also the
                                    // button.
                                    data-role="children-toggle"
                                    data-child-chip="true"
                                    draggable={false}
                                    aria-expanded={expanded}
                                    title={`${childCount} direct · ${getDescendants(allTasks, task.id).length} in tree — activate to ${expanded ? "collapse" : "expand"}`}
                                    style={{
                                          fontSize: 9,
                                          color: "var(--t-text-muted)",
                                          cursor: "pointer",
                                          flexShrink: 0,
                                    }}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onMouseEnter={() => {
                                          if (childHoverTimeout.current)
                                                clearTimeout(
                                                      childHoverTimeout.current,
                                                );
                                          // Capture chip rect for fixed positioning
                                          if (childChipRef.current) {
                                                setChildChipRect(
                                                      childChipRef.current.getBoundingClientRect(),
                                                );
                                          }
                                          // Hover shows popover preview only when not expanded inline
                                          if (!expanded) {
                                                childHoverTimeout.current =
                                                      setTimeout(
                                                            () =>
                                                                  setShowChildPopover(
                                                                        true,
                                                                  ),
                                                            200,
                                                      );
                                          }
                                    }}
                                    onMouseLeave={() => {
                                          if (childHoverTimeout.current)
                                                clearTimeout(
                                                      childHoverTimeout.current,
                                                );
                                          // Hover close only when not pinned (pinned = in-flow expanded)
                                          if (!expanded)
                                                setShowChildPopover(false);
                                    }}
                                    onClick={(e) => {
                                          e.stopPropagation();
                                          toggleExpanded(!expanded);
                                    }}
                                    onKeyDown={(e) => {
                                          if (
                                                e.key === "Enter" ||
                                                e.key === " "
                                          ) {
                                                e.stopPropagation();
                                                toggleExpanded(!expanded);
                                          } else if (e.key === "Escape") {
                                                toggleExpanded(false);
                                          }
                                    }}
                              >
                                    <span className="child-toggle-label">{`⤷${childCount}`}</span>
                                    <ChevronDown
                                          className="child-toggle-chevron"
                                          style={{ width: 13, height: 13 }}
                                    />
                              </span>
                        )}
                  </div>

                  {/* Children zone — INSIDE the card, animated via CSS grid rows */}
                  {(() => {
                        const children = getLeafDescendants(allTasks, task.id);
                        if (children.length === 0) return null;
                        return (
                              <div
                                    className="card-children-zone"
                                    data-role="children-block"
                                    data-drop-role="children-zone"
                                    data-expanded={expanded}
                                    style={{ position: "relative" }}
                                    onDragOver={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          if (onChildrenZoneDragOver)
                                                onChildrenZoneDragOver(e);
                                    }}
                                    onDragLeave={(e) => {
                                          if (onChildrenZoneDragLeave)
                                                onChildrenZoneDragLeave(e);
                                    }}
                                    onDrop={(e) => {
                                          e.preventDefault();
                                          // Intentionally NOT stopping propagation —
                                          // the column's handleDrop reads zoneDropTargetRef
                                          // to process the make-child action.
                                    }}
                              >
                                    <div className="card-children-zone-inner">
                                          <RecursiveChildrenTree
                                                parentId={task.id}
                                                allTasks={allTasks}
                                                variant="inline"
                                                dragIntent={treeIntent}
                                                onTreeIntent={onTreeIntent}
                                                isDragging={isDragging}
                                                onRowDragStart={
                                                      onTreeRowDragStart
                                                }
                                                onOpen={(child) => {
                                                      if (onOpenChild)
                                                            onOpenChild(child);
                                                      else onOpen(child);
                                                }}
                                                onRemove={
                                                      onDetach
                                                            ? (childId) =>
                                                                    onDetach(
                                                                          childId,
                                                                    )
                                                            : undefined
                                                }
                                          />
                                    </div>
                              </div>
                        );
                  })()}

                  {/* First-child slot — the tree renders null when idle
                      (zero layout change) and a dashed drop slot while a
                      drag session is active. Drops bubble to the column
                      handler → existing onLinkChild path. */}
                  {childCount === 0 && (
                        <RecursiveChildrenTree
                              parentId={task.id}
                              allTasks={allTasks}
                              variant="inline"
                              dragIntent={treeIntent}
                              onTreeIntent={onTreeIntent}
                              isDragging={isDragging}
                              onRowDragStart={onTreeRowDragStart}
                        />
                  )}

                  {/* Child popover — suppressed while expanded */}
                  {showChildPopover &&
                        directChildren.length > 0 &&
                        !expanded && (
                              <ChildPopover
                                    task={task}
                                    allTasks={allTasks}
                                    anchorRect={childChipRect}
                                    onOpenTask={(child) => {
                                          setShowChildPopover(false);
                                          if (onOpenTask) onOpenTask(child);
                                          else onOpen(child);
                                    }}
                              />
                        )}
            </article>
      );
});

interface CardIconButtonProps {
      icon: React.ReactNode;
      label: string;
      color: string;
      hoverColor: string;
      title: string;
      badge?: boolean;
      badgeColor?: string;
      onClick: (e: React.MouseEvent) => void;
}

function CardIconButton({
      icon,
      label,
      color,
      hoverColor,
      title,
      badge,
      badgeColor,
      onClick,
}: CardIconButtonProps) {
      const [hovered, setHovered] = React.useState(false);
      return (
            <button
                  style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 2,
                        padding: "2px 3px",
                        borderRadius: 3,
                        border: "none",
                        background: hovered
                              ? "color-mix(in srgb, var(--t-text-muted) 10%, transparent)"
                              : "transparent",
                        cursor: "pointer",
                        fontSize: 9,
                        color: hovered ? hoverColor : color,
                        transition: "color .1s, background .1s",
                        // Action buttons never shrink: the activity cluster
                        // truncates before them (0bc9922f).
                        flexShrink: 0,
                  }}
                  title={title}
                  onMouseEnter={() => setHovered(true)}
                  onMouseLeave={() => setHovered(false)}
                  onClick={onClick}
            >
                  {icon}
                  {label && <span>{label}</span>}
                  {badge && (
                        <span
                              style={{
                                    width: 4,
                                    height: 4,
                                    background: badgeColor ?? color,
                                    borderRadius: "50%",
                                    flexShrink: 0,
                              }}
                        />
                  )}
            </button>
      );
}

interface LiveActivityBadgeProps {
      /** Peers currently in the task. One 18px initials circle each;
          crowds collapse to a "+N" chip (vibeflow task 0bc9922f). */
      activities: LiveActivity[];
}

/** Max initials circles before the "+N" overflow chip. */
export const LIVE_BADGE_MAX_CIRCLES = 3;

export function liveActivityLabel(activity: LiveActivity): string {
      // Neutral presence sentence — never a lock. Locks are gone: everyone can
      // edit, and this badge only says who else is here and where.
      const areaSuffix = activity.area
            ? ` \u00b7 ${presenceAreaLabel(activity.area)}`
            : "";
      return `${activity.user} ${activity.state === "editing" ? "editing" : "viewing"}${areaSuffix}`;
}

export function LiveActivityBadge({ activities }: LiveActivityBadgeProps) {
      if (activities.length === 0) return null;
      // Full roster in the hover tooltip AND the screen-reader label: the
      // circles carry initials only, so this is the one place every name
      // is readable.
      const label = activities.map(liveActivityLabel).join("; ");
      const visible = activities.slice(0, LIVE_BADGE_MAX_CIRCLES);
      const hidden = activities.slice(LIVE_BADGE_MAX_CIRCLES);
      const circleStyle = (
            backgroundColor: string,
            overlap: boolean,
      ): React.CSSProperties => ({
            width: 18,
            height: 18,
            borderRadius: "50%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 8,
            fontWeight: 700,
            lineHeight: 1,
            color: "#fff",
            textShadow: "0 1px 2px rgba(0,0,0,0.55)",
            backgroundColor,
            boxShadow: "0 0 0 2px var(--t-surface)",
            marginLeft: overlap ? -5 : 0,
            flexShrink: 0,
            cursor: "default",
      });
      // The cluster never wraps and never pushes the card's action buttons
      // out: it owns no flex growth, shrinks to zero, and clips under
      // extreme squeeze (the "+N" chip + tooltip keep every name
      // reachable). Same initials-in-a-circle pattern as the detail panel's
      // PresenceStack, including the per-user hue.
      return (
            <span
                  style={{
                        display: "inline-flex",
                        alignItems: "center",
                        flexWrap: "nowrap",
                        minWidth: 0,
                        overflow: "hidden",
                        flexShrink: 1,
                  }}
                  title={label}
                  aria-label={label}
                  role="group"
                  data-testid="live-activity-badge"
            >
                  {visible.map((a, i) => (
                        <span
                              key={a.userId ?? a.user}
                              title={liveActivityLabel(a)}
                              style={circleStyle(
                                    presenceChipFill(a.userId),
                                    i > 0,
                              )}
                        >
                              {presenceInitials(a.user)}
                        </span>
                  ))}
                  {hidden.length > 0 && (
                        <span
                              title={hidden.map(liveActivityLabel).join("; ")}
                              aria-label={`${hidden.length} more: ${hidden.map(liveActivityLabel).join("; ")}`}
                              style={circleStyle("hsl(220, 9%, 45%)", true)}
                        >
                              +{hidden.length}
                        </span>
                  )}
            </span>
      );
}
