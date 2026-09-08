import React, { useState, useCallback } from "react";
import type { Task, TaskLinkType } from "../types";
import { shortId, getChildren } from "../task-links";
import { TASK_LINK_TYPES } from "../types";
import { ChildRow } from "./ChildRow";

interface RelationsSectionProps {
  task: Task;
  allTasks: Task[];
  onUpdateLinks: (links: Task["links"]) => void;
  onOpenTask?: (task: Task) => void;
}

const TYPE_LABELS: Record<TaskLinkType, string> = {
  parent: "Child of →",
  relates: "related",
  blocks: "blocks",
};

/** Badge labels for existing relation rows (distinct from picker labels). */
const TYPE_BADGE_LABELS: Record<TaskLinkType, string> = {
  parent: "↑ parent",
  relates: "related",
  blocks: "blocks",
};

const TYPE_COLORS: Record<TaskLinkType, string> = {
  parent: "#a78bfa",
  relates: "#60a5fa",
  blocks: "#f87171",
};

export default function RelationsSection({
  task,
  allTasks,
  onUpdateLinks,
  onOpenTask,
}: RelationsSectionProps) {
  const [adding, setAdding] = useState(false);
  const [linkType, setLinkType] = useState<TaskLinkType>("relates");
  const [search, setSearch] = useState("");
  const [childrenOpen, setChildrenOpen] = useState(false);
  const [relationsOpen, setRelationsOpen] = useState(false);

  const links = task.links ?? [];
  const filtered = search.trim()
    ? allTasks.filter(
        (t) =>
          t.id !== task.id &&
          (t.id.toLowerCase().includes(search.toLowerCase()) ||
            (t.title ?? "").toLowerCase().includes(search.toLowerCase())),
      )
    : [];

  const handleAdd = useCallback(
    (targetId: string) => {
      const newLinks = [...links, { taskId: targetId, type: linkType }];
      onUpdateLinks(newLinks);
      setAdding(false);
      setSearch("");
    },
    [links, linkType, onUpdateLinks],
  );

  const handleRemove = useCallback(
    (idx: number) => {
      const newLinks = links.filter((_, i) => i !== idx);
      onUpdateLinks(newLinks);
    },
    [links, onUpdateLinks],
  );

  const children = getChildren(allTasks, task.id);
  const hasChildren = children.length > 0;

  return (
    <div className="relations-section">
      {/* Derived children block — collapsed by default */}
      {hasChildren && (
        <div className="children-block" data-role="children-block">
          <button
            className="children-block-header"
            data-role="children-toggle"
            title="Children are derived — set a parent link on the child task"
            aria-expanded={childrenOpen}
            onClick={() => setChildrenOpen(!childrenOpen)}
          >
            <span className="children-block-title">Children</span>
            <span className="children-block-count">{children.length}</span>
            <span className="block-chevron">▶</span>
          </button>
          {childrenOpen && (
            <div className="children-block-rows">
              {children.map((child) => (
                <ChildRow
                  key={child.id}
                  child={child}
                  variant="detail"
                  onOpen={() => onOpenTask?.(child)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Relations — collapsed by default */}
      <button
        className="relations-header"
        data-role="relations-toggle"
        aria-expanded={relationsOpen}
        onClick={() => setRelationsOpen(!relationsOpen)}
      >
        <span className="relations-title">Relations</span>
        <span className="relations-count">{links.length}</span>
        <span className="block-chevron">▶</span>
      </button>

      {relationsOpen && links.length > 0 && (
        <div className="relations-list">
          {links.map((link, idx) => {
            const target = allTasks.find((t) => t.id === link.taskId);
            return (
              <div
                key={`${link.taskId}-${link.type}-${idx}`}
                className={`relation-row${target ? " relation-row--clickable" : ""}`}
                data-role="relation-row"
                data-task-id={target ? link.taskId : undefined}
                style={target ? { cursor: "pointer" } : undefined}
                onClick={
                  target
                    ? (e) => {
                        e.stopPropagation();
                        onOpenTask?.(target);
                      }
                    : undefined
                }
              >
                <span
                  className="relation-type-badge"
                  style={{
                    backgroundColor: TYPE_COLORS[link.type] + "22",
                    color: TYPE_COLORS[link.type],
                  }}
                >
                  {TYPE_BADGE_LABELS[link.type]}
                </span>
                {target ? (
                  <>
                    <span
                      className="relation-status-dot"
                      style={{ backgroundColor: getStatusColor(target.status) }}
                    />
                    <span className="relation-id">{shortId(target.id)}</span>
                    <span className="relation-title">{target.title}</span>
                  </>
                ) : (
                  <span className="relation-dangling">
                    not found ({shortId(link.taskId)})
                  </span>
                )}
                <button
                  className="relation-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(idx);
                  }}
                  title="Remove link"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* + Add button — always visible, auto-expands relations when clicked */}
      {!adding && (
        <button
          className="relations-add-btn"
          onClick={() => {
            setAdding(true);
            setRelationsOpen(true);
          }}
        >
          + Add
        </button>
      )}

      {adding && (
        <div className="relations-add-panel">
          <div className="relations-type-picker">
            {TASK_LINK_TYPES.map((t) => (
              <button
                key={t}
                className={`relations-type-btn ${linkType === t ? "active" : ""}`}
                style={
                  linkType === t
                    ? { borderColor: TYPE_COLORS[t], color: TYPE_COLORS[t] }
                    : undefined
                }
                onClick={() => setLinkType(t)}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
          {linkType === "parent" && (
            <div className="relations-hint">
              This task becomes a child of the selected task.
            </div>
          )}
          <input
            className="relations-search"
            placeholder="Search by id or title..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {filtered.length > 0 && (
            <div className="relations-results">
              {filtered.slice(0, 10).map((t) => (
                <button
                  key={t.id}
                  className="relation-result-row"
                  onClick={() => handleAdd(t.id)}
                >
                  <span
                    className="relation-status-dot"
                    style={{ backgroundColor: getStatusColor(t.status) }}
                  />
                  <span className="relation-id">{shortId(t.id)}</span>
                  <span className="relation-title">{t.title}</span>
                </button>
              ))}
            </div>
          )}
          <button
            className="relations-cancel-btn"
            onClick={() => {
              setAdding(false);
              setSearch("");
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function getStatusColor(status?: string): string {
  switch (status) {
    case "done":
      return "#22c55e";
    case "review":
      return "#f59e0b";
    case "in-progress":
      return "#3b82f6";
    case "todo":
      return "#64748b";
    case "backlog":
      return "#475569";
    default:
      return "#64748b";
  }
}
