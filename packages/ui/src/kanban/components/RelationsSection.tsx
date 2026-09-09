import { useState, useCallback } from "react";
import type { Task, TaskLinkType } from "../types";
import { shortId, groupDetailRelations, getStatusColor } from "../task-links";
import { TASK_LINK_TYPES } from "../types";

interface RelationsSectionProps {
  task: Task;
  allTasks: Task[];
  onUpdateLinks: (links: Task["links"]) => void;
  onOpenTask?: (task: Task) => void;
  /** Sibling reorder inside one parent (tree-row intent, same parent). */
  onTreeReorder?: (
    draggedId: string,
    targetId: string,
    position: "before" | "after",
    parentId: string,
  ) => void;
  /** Move under a different parent (tree-row across parents, or zone drop). */
  onTreeReparent?: (
    draggedId: string,
    newParentId: string,
    targetId?: string,
    position?: "before" | "after",
  ) => void;
}

const TYPE_LABELS: Record<TaskLinkType, string> = {
  parent: "Child of →",
  relates: "related",
  blocks: "blocks",
};

/** Colors per relation type — parent is blue (matches children), relates purple, blocks red. */
const TYPE_COLORS: Record<TaskLinkType, string> = {
  parent: "#60a5fa",
  relates: "#a78bfa",
  blocks: "#f87171",
};

/* ── Component ────────────────────────────────────────────────────────────── */

/**
 * Detail-panel Relations section — collapsed-always. Renders the header row
 * (title + flat count chips + collapsed chevron, no toggle) plus the
 * relation search/add UI. The detail tree display was removed; card-zone
 * trees in TaskCard are untouched.
 */
export default function RelationsSection({
  task,
  allTasks,
  onUpdateLinks,
}: RelationsSectionProps) {
  const [adding, setAdding] = useState(false);
  const [linkType, setLinkType] = useState<TaskLinkType>("relates");
  const [search, setSearch] = useState("");

  const safeTasks = allTasks ?? [];

  const links = task.links ?? [];

  const groups = groupDetailRelations(task, safeTasks);

  const searchResults = search.trim()
    ? safeTasks.filter(
        (t) =>
          t?.id !== task.id &&
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

  return (
    <div className="relations-section" data-role="relations-area">
      {/* ── Header (collapsed-always, no toggle) with summary chips ── */}
      <div className="relations-area-header" data-role="relations-area-header">
        <span className="relations-area-title">Relations</span>
        {groups.children.length > 0 && (
          <span className="relation-chip relation-chip--children">
            {groups.children.length}{" "}
            {groups.children.length === 1 ? "child" : "children"}
          </span>
        )}
        {groups.parentLinks.length > 0 && (
          <span className="relation-chip relation-chip--parent">
            {groups.parentLinks.length}{" "}
            {groups.parentLinks.length === 1 ? "parent" : "parents"}
          </span>
        )}
        {groups.blocksLinks.length > 0 && (
          <span className="relation-chip">
            {groups.blocksLinks.length} blocks
          </span>
        )}
        {groups.relatesLinks.length > 0 && (
          <span className="relation-chip">
            {groups.relatesLinks.length} related
          </span>
        )}
        <span className="block-chevron">▾</span>
      </div>

      {/* ── + Add relation ── */}
      {!adding && (
        <button
          className="relations-add-btn"
          data-role="relations-add"
          onClick={() => setAdding(true)}
        >
          + Add
        </button>
      )}

      {/* ── Add panel ── */}
      {adding && (
        <div className="relations-add-panel">
          <div className="relations-type-picker">
            {TASK_LINK_TYPES.map((t) => (
              <button
                key={t}
                className={`relations-type-btn ${linkType === t ? "active" : ""}`}
                style={
                  linkType === t
                    ? {
                        borderColor: TYPE_COLORS[t],
                        color: TYPE_COLORS[t],
                      }
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
          {searchResults.length > 0 && (
            <div className="relations-results">
              {searchResults.slice(0, 10).map((t) => (
                <button
                  key={t.id}
                  className="relation-result-row"
                  onClick={() => handleAdd(t.id)}
                >
                  <span
                    className="relation-status-dot"
                    style={{
                      backgroundColor: getStatusColor(t.status),
                    }}
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
