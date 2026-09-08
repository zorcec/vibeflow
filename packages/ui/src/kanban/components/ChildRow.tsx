import React from "react";
import type { Task } from "../types";
import { getStatusColor, shortId } from "../task-links";

interface ChildRowProps {
  child: Task;
  onOpen?: () => void;
  variant: "popover" | "detail" | "inline";
}

export function ChildRow({ child, onOpen, variant }: ChildRowProps) {
  const isInline = variant === "inline";
  return (
    <button
      className={`child-link-row child-link-row--${variant}`}
      data-role="child-link-row"
      style={isInline ? { position: "relative", paddingLeft: 14 } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.();
      }}
    >
      {/* Inline: status dot positioned ON the wrapper's dotted borderLeft */}
      {isInline && (
        <span
          className="child-link-dot child-link-dot--on-line"
          style={{ backgroundColor: getStatusColor(child.status) }}
        />
      )}
      {!isInline && <span className="child-link-connector" />}
      {!isInline && (
        <span
          className="child-link-dot"
          style={{ backgroundColor: getStatusColor(child.status) }}
        />
      )}
      <span className="child-link-id">{shortId(child.id)}</span>
      <span className="child-link-title">{child.title}</span>
    </button>
  );
}
