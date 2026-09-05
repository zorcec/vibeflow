import React from "react";
import ReactDOM from "react-dom";
import { MessageCircle, Paperclip, CheckCircle, Eye, Lock } from "lucide-react";
import type { Task, Column, LiveActivity } from "../types";
import { isNewComments } from "../utils";
import { TypeBadge } from "../../TypeBadge";
import { PriorityBadge } from "../../PriorityBadge";
import { getTaskTypeColor, TASK_TYPE_ICONS } from "../../task-types";
import { TagPills } from "./shared/TagPills";

interface Props {
      task: Task;
      col: Column;
      liveActivity?: LiveActivity;
      compact?: boolean;
      onOpen: (task: Task, tab?: "details" | "comments" | "files") => void;
      onDragStart: (e: React.DragEvent, taskId: string) => void;
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
            "color-mix(in srgb, var(--p-text-g) 40%, transparent)"
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
const DONE_CHECK_ICON_STYLE: React.CSSProperties = {
      width: 12,
      height: 12,
      color: "color-mix(in srgb, var(--p-green) 55%, transparent)",
      flexShrink: 0,
};
const DONE_TITLE_STYLE: React.CSSProperties = {
      fontSize: 11.5,
      fontWeight: 600,
      color: "var(--p-text-m)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      flex: 1,
};
const VERIFIED_BADGE_STYLE: React.CSSProperties = {
      fontSize: 9,
      fontWeight: 700,
      color: "#22c55e",
      background: "rgba(34,197,94,0.12)",
      border: "1px solid rgba(34,197,94,0.3)",
      borderRadius: 4,
      padding: "1px 5px",
      marginLeft: 6,
      flexShrink: 0,
      letterSpacing: 0.5,
};

const CARD_TITLE_ROW_STYLE: React.CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: 5,
      minWidth: 0,
};
const SPINNER_SHRINK_STYLE: React.CSSProperties = { flexShrink: 0 };
const CARD_TITLE_TEXT_STYLE: React.CSSProperties = {
      fontSize: 11.5,
      fontWeight: 600,
      color: "var(--p-text)",
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
      color: "var(--p-text-g)",
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
      border: "1px solid color-mix(in srgb, var(--p-border) 90%, transparent)",
      display: "block",
      cursor: "pointer",
};
const CARD_FOOTER_STYLE: React.CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: 2,
      marginTop: 1,
};
const SPACER_STYLE: React.CSSProperties = { flex: 1 };

export const TaskCard = React.memo(function TaskCard({
      task,
      col,
      liveActivity,
      compact,
      onOpen,
      onDragStart,
}: Props) {
      const isInProgress = col.id === "in-progress";
      const isDone = col.id === "done";
      const [showThumbPreview, setShowThumbPreview] = React.useState(false);
      const [thumbRect, setThumbRect] = React.useState<{
            top: number;
            right: number;
      } | null>(null);
      const thumbRef = React.useRef<HTMLImageElement>(null);

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
            onDragStart(e, task.id);
            e.currentTarget.classList.add("dragging");
      }

      function handleDragEnd(e: React.DragEvent) {
            e.currentTarget.classList.remove("dragging");
      }

      function handleClick() {
            onOpen(task);
      }

      // Compact view (any lane) or done column: single-row card
      if (compact || isDone) {
            const dotClass =
                  col.id === "in-progress" ? "sd-inprogress" : `sd-${col.id}`;
            return (
                  <article
                        className="task-card"
                        draggable
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
                              {isDone ? (
                                    <CheckCircle
                                          style={DONE_CHECK_ICON_STYLE}
                                    />
                              ) : (
                                    <span
                                          className={dotClass}
                                          style={{ flexShrink: 0 }}
                                    />
                              )}
                              <span
                                    style={{
                                          ...DONE_TITLE_STYLE,
                                          ...(isDone
                                                ? {}
                                                : { color: "var(--p-text)" }),
                                    }}
                              >
                                    {task.title}
                              </span>
                              {/* Compact/done: title only — no tags, no counts */}
                              {!compact &&
                                    !isDone &&
                                    task.tags &&
                                    task.tags.length > 0 && (
                                          <TagPills
                                                tags={task.tags}
                                                size="xs"
                                          />
                                    )}
                              {!compact &&
                                    !isDone &&
                                    (commentCount > 0 || fileCount > 0) && (
                                          <span
                                                style={{
                                                      fontSize: 9,
                                                      color: "var(--p-text-m)",
                                                      flexShrink: 0,
                                                }}
                                          >
                                                {commentCount > 0 &&
                                                      `💬${commentCount}`}
                                                {commentCount > 0 &&
                                                      fileCount > 0 &&
                                                      " "}
                                                {fileCount > 0 &&
                                                      `📎${fileCount}`}
                                          </span>
                                    )}
                              {isDone && task.verified && (
                                    <span style={VERIFIED_BADGE_STYLE}>
                                          ✓ VERIFIED
                                    </span>
                              )}
                        </div>
                  </article>
            );
      }
      return (
            <article
                  className={`task-card${liveActivity ? " task-live-edit" : ""}`}
                  draggable
                  data-task-id={task.id}
                  style={{
                        padding: "7px 8px",
                        gap: 4,
                        userSelect: "none",
                        background: liveActivity
                              ? "rgba(59,130,246,0.08)"
                              : cardBgColor,
                        border: liveActivity
                              ? "1px solid rgba(59,130,246,0.5)"
                              : cardBorderColor
                                ? `1px solid ${cardBorderColor}`
                                : undefined,
                        ...(liveActivity
                              ? { boxShadow: "0 0 0 2px rgba(59,130,246,0.14)" }
                              : {}),
                  }}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onClick={handleClick}
            >
                  {/* Row 1: title [screenshot-thumb] */}
                  <div style={CARD_TITLE_ROW_STYLE}>
                        {isInProgress && (
                              <span
                                    className="spinner"
                                    style={SPINNER_SHRINK_STYLE}
                              />
                        )}
                        <span style={CARD_TITLE_TEXT_STYLE}>{task.title}</span>
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
                                                                  border: "1px solid color-mix(in srgb, var(--p-border) 96%, transparent)",
                                                                  boxShadow:
                                                                        "0 10px 24px color-mix(in srgb, var(--p-bg) 75%, transparent)",
                                                                  pointerEvents:
                                                                        "none",
                                                                  zIndex: 9999,
                                                                  background:
                                                                        "var(--p-bg)",
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
                                          color: "#60a5fa",
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
                              <LiveActivityBadge activity={liveActivity} />
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
                                          ? "var(--p-purple)"
                                          : commentCount > 0
                                            ? "var(--p-text-m)"
                                            : "var(--p-border-t)"
                              }
                              hoverColor={
                                    hasNewComments
                                          ? "var(--p-purple-300)"
                                          : "var(--p-text)"
                              }
                              title={
                                    commentCount > 0
                                          ? `${commentCount} comment(s)`
                                          : "Add comment"
                              }
                              badge={hasNewComments}
                              badgeColor="var(--p-purple)"
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
                                          ? "var(--p-blue-300)"
                                          : "var(--p-border-t)"
                              }
                              hoverColor={
                                    fileCount > 0
                                          ? "var(--p-cyan-300)"
                                          : "var(--p-text-sub)"
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
                  </div>
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
                              ? "color-mix(in srgb, var(--p-text-m) 10%, transparent)"
                              : "transparent",
                        cursor: "pointer",
                        fontSize: 9,
                        color: hovered ? hoverColor : color,
                        transition: "color .1s, background .1s",
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
      activity: LiveActivity;
}

export function LiveActivityBadge({ activity }: LiveActivityBadgeProps) {
      const isLocked =
            activity.state === "locked" || activity.state === "editing";
      const icon = isLocked ? (
            <Lock style={{ width: 8, height: 8 }} />
      ) : (
            <Eye style={{ width: 8, height: 8 }} />
      );

      const label = isLocked
            ? `Locked by ${activity.user}`
            : `${activity.user} viewing`;

      const badgeStyle: React.CSSProperties = isLocked
            ? {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    borderRadius: 999,
                    padding: "1px 5px",
                    fontSize: 9,
                    fontWeight: 600,
                    border: "1px solid rgba(244,114,182,0.35)",
                    color: "#f9a8d4",
                    background: "rgba(157,23,77,0.28)",
                    flexShrink: 0,
                    maxWidth: 110,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    flexWrap: "nowrap",
              }
            : {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    borderRadius: 999,
                    padding: "1px 5px",
                    fontSize: 9,
                    fontWeight: 600,
                    border: "1px solid rgba(59,130,246,0.35)",
                    color: "#93c5fd",
                    background: "rgba(30,58,138,0.28)",
                    flexShrink: 0,
                    maxWidth: 110,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    flexWrap: "nowrap",
              };

      return (
            <span
                  style={badgeStyle}
                  title={label}
                  data-testid="live-activity-badge"
            >
                  {icon}
                  <span
                        style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              minWidth: 0,
                              flex: "1 1 0",
                        }}
                  >
                        {activity.user}
                  </span>
            </span>
      );
}
