import React from "react";
import { MessageCircle, Paperclip } from "lucide-react";
import type { KanbanTask, KanbanColumn, KanbanHandlers } from "./types";
import { TypeBadge } from "./TypeBadge";
import { PriorityBadge } from "./PriorityBadge";

interface Props {
  task: KanbanTask;
  col: KanbanColumn;
  handlers: KanbanHandlers;
  onDragStart?: (e: React.DragEvent, taskId: string) => void;
}

export function KanbanCard({ task, col, handlers, onDragStart }: Props) {
  const isDone = task.status === "done";

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("text/plain", task.id);
    onDragStart?.(e, task.id);
    (e.currentTarget as HTMLElement).style.opacity = "0.4";
  }

  function handleDragEnd(e: React.DragEvent) {
    (e.currentTarget as HTMLElement).style.opacity = "";
  }

  const borderColor =
    col.color.startsWith("#")
      ? `${col.color}${task.priority === "Critical" ? "5c" : "3d"}`
      : `color-mix(in srgb, ${col.color} ${task.priority === "Critical" ? "36%" : "24%"}, transparent)`;

  if (isDone) {
    return (
      <article
        draggable
        data-task-id={task.id}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onClick={() => handlers.onCardClick?.(task)}
        style={{
          background: "var(--p-card)",
          border: `1px solid ${borderColor}`,
          borderRadius: 10,
          padding: "7px 10px",
          cursor: "pointer",
          opacity: 0.45,
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--p-text-g)",
            textDecoration: "line-through",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task.title}
        </span>
      </article>
    );
  }

  return (
    <article
      draggable
      data-task-id={task.id}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={() => handlers.onCardClick?.(task)}
      style={{
        background: "var(--p-card)",
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        padding: "11px 13px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 7,
        transition: "border-color .12s, background .12s, box-shadow .12s, transform .12s",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        el.style.borderColor = "color-mix(in srgb, var(--p-blue) 50%, transparent)";
        el.style.background = "var(--p-hover)";
        el.style.boxShadow = "0 4px 16px rgba(0,0,0,0.3)";
        el.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget;
        el.style.borderColor = borderColor;
        el.style.background = "var(--p-card)";
        el.style.boxShadow = "";
        el.style.transform = "";
      }}
    >
      {/* Title */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 5, minWidth: 0 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--p-text)",
            lineHeight: 1.4,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {task.title}
        </span>
      </div>

      {/* Description preview */}
      {task.description && (
        <p
          style={{
            fontSize: 10.5,
            color: "var(--p-text-g)",
            margin: 0,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            lineHeight: 1.5,
          }}
        >
          {task.description}
        </p>
      )}

      {/* Footer badges + stats */}
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginTop: "auto" }}>
        <TypeBadge type={task.type} />
        {task.priority && <PriorityBadge priority={task.priority} />}
        <div style={{ flex: 1 }} />
        {!!task.commentCount && (
          <span
            style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 10, color: "var(--p-text-f)" }}
          >
            <MessageCircle style={{ width: 10, height: 10 }} />
            {task.commentCount}
          </span>
        )}
        {!!task.fileCount && (
          <span
            style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 10, color: "var(--p-text-f)" }}
          >
            <Paperclip style={{ width: 10, height: 10 }} />
            {task.fileCount}
          </span>
        )}
      </div>
    </article>
  );
}
