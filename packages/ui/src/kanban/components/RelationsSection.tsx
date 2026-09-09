import React, { useState, useCallback, useEffect, useRef } from "react";
import type { Task, TaskLinkType } from "../types";
import {
  shortId,
  groupDetailRelations,
  getStatusColor,
  getChildren,
  getParent,
  canReparent,
  dragSession,
} from "../task-links";
import type { DetailRelationRow, DropIntent } from "../task-links";
import { TASK_LINK_TYPES } from "../types";
import { compareTaskOrder } from "../utils";
import { RecursiveChildrenTree } from "./RecursiveChildrenTree";

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

export default function RelationsSection({
  task,
  allTasks,
  onUpdateLinks,
  onOpenTask,
  onTreeReorder,
  onTreeReparent,
}: RelationsSectionProps) {
  // Collapsed by default: opening a task's detail panel shows the Relations
  // header with summary chips; the tree stays hidden until expanded.
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [linkType, setLinkType] = useState<TaskLinkType>("relates");
  const [search, setSearch] = useState("");

  // Tree DnD intent — shared by all four group trees in this section.
  // The dragged id travels via the dragSession singleton (no prop-drilling).
  const [treeIntent, setTreeIntent] = useState<DropIntent | null>(null);
  const treeIntentRef = useRef<DropIntent | null>(null);
  const safeTasks = allTasks ?? [];

  // Re-collapse whenever a different task is opened (the detail panel reuses
  // one component instance across selections, so state would otherwise persist).
  useEffect(() => {
    setOpen(false);
  }, [task.id]);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  const expand = useCallback(() => {
    setOpen(true);
  }, []);

  const links = task.links ?? [];

  const groups = groupDetailRelations(task, safeTasks);
  const totalCount = groups.children.length + links.length;

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

  const handleRemove = useCallback(
    (idx: number) => {
      const newLinks = links.filter((_, i) => i !== idx);
      onUpdateLinks(newLinks);
    },
    [links, onUpdateLinks],
  );

  const handleRemoveChildLink = useCallback(
    (childId: string) => {
      const idx = links.findIndex(
        (l) => l?.type === "parent" && l?.taskId === childId,
      );
      if (idx >= 0) handleRemove(idx);
    },
    [links, handleRemove],
  );

  /** Removal for a flat group: resolve the link index by target task id. */
  const makeRemoveByTaskId = useCallback(
    (rows: DetailRelationRow[]) => (taskId: string) => {
      const row = rows.find((r) => r?.link?.taskId === taskId);
      if (row) handleRemove(row.linkIndex);
    },
    [handleRemove],
  );

  const handleTreeIntent = useCallback((intent: DropIntent | null) => {
    treeIntentRef.current = intent;
    setTreeIntent(intent);
  }, []);

  /** Section-level drop: row drops bubble here (outside the board columns). */
  const handleTreeDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const draggedId = dragSession.get();
      const intent = treeIntentRef.current;
      if (!draggedId || !intent) return;
      if (intent.kind === "tree-row" && intent.targetId && intent.parentId) {
        if (draggedId === intent.targetId) return;
        if (!canReparent(safeTasks, draggedId, intent.parentId)) return;
        const cur = getParent(safeTasks, draggedId)?.id ?? null;
        if (cur === intent.parentId) {
          onTreeReorder?.(
            draggedId,
            intent.targetId,
            intent.position ?? "after",
            intent.parentId,
          );
        } else {
          onTreeReparent?.(
            draggedId,
            intent.parentId,
            intent.targetId,
            intent.position,
          );
        }
      } else if (intent.kind === "zone" && intent.parentId) {
        if (draggedId === intent.parentId) return;
        if (!canReparent(safeTasks, draggedId, intent.parentId)) return;
        const cur = getParent(safeTasks, draggedId)?.id ?? null;
        if (cur === intent.parentId) {
          // Gap drop within the same parent → append-last reorder.
          const sibs = getChildren(safeTasks, intent.parentId)
            .filter((t) => t?.id && t.id !== draggedId)
            .sort(compareTaskOrder);
          const last = sibs[sibs.length - 1];
          if (!last?.id) return;
          onTreeReorder?.(draggedId, last.id, "after", intent.parentId);
        } else {
          onTreeReparent?.(draggedId, intent.parentId);
        }
      }
      dragSession.end();
      treeIntentRef.current = null;
      setTreeIntent(null);
    },
    [safeTasks, onTreeReorder, onTreeReparent],
  );

  const handleTreeDragEnd = useCallback(() => {
    dragSession.end();
    treeIntentRef.current = null;
    setTreeIntent(null);
  }, []);

  const allGroupsEmpty =
    groups.children.length === 0 &&
    groups.parentLinks.length === 0 &&
    groups.blocksLinks.length === 0 &&
    groups.relatesLinks.length === 0;

  return (
    <div className="relations-section" data-role="relations-area">
      {/* ── Header toggle with summary chips ── */}
      <button
        className="relations-area-header"
        data-role="relations-area-toggle"
        aria-expanded={open}
        onClick={toggleOpen}
      >
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
        <span className="block-chevron" data-open={open || undefined}>
          ▾
        </span>
      </button>

      {/* ── Expanded body ── */}
      {open && (
        <div
          className="relations-area-body"
          data-role="relations-area-body"
          onDrop={handleTreeDrop}
          onDragEnd={handleTreeDragEnd}
        >
          {/* ── CHILDREN group ── */}
          {groups.children.length > 0 && (
            <div
              className="relation-group relation-group--children"
              data-role="relation-group-children"
            >
              <div className="relation-group-header">
                <span className="relation-group-dot" />
                <span className="relation-group-label">
                  CHILDREN · {groups.children.length}
                </span>
              </div>
              <div className="relation-group-rows">
                <RecursiveChildrenTree
                  parentId={task.id}
                  allTasks={safeTasks}
                  variant="detail"
                  onOpen={(child) => onOpenTask?.(child)}
                  onRemove={handleRemoveChildLink}
                  dragIntent={treeIntent}
                  onTreeIntent={handleTreeIntent}
                />
              </div>
            </div>
          )}

          {/* ── PARENT LINKS group (explicit "child of →" links on this task) ── */}
          {groups.parentLinks.length > 0 && (
            <div
              className="relation-group relation-group--parent"
              data-role="relation-group-parent"
            >
              <div className="relation-group-header">
                <span
                  className="relation-group-dot"
                  style={{
                    backgroundColor: "#60a5fa",
                  }}
                />
                <span className="relation-group-label">
                  PARENT · {groups.parentLinks.length}
                </span>
              </div>
              <div className="relation-group-rows">
                <RecursiveChildrenTree
                  parentId={task.id}
                  allTasks={safeTasks}
                  variant="detail"
                  nodes={toTreeNodes(groups.parentLinks)}
                  onOpen={(child) => onOpenTask?.(child)}
                  onRemove={makeRemoveByTaskId(groups.parentLinks)}
                  dragIntent={treeIntent}
                  onTreeIntent={handleTreeIntent}
                />
              </div>
            </div>
          )}

          {/* ── BLOCKS group ── */}
          {groups.blocksLinks.length > 0 && (
            <div
              className="relation-group relation-group--blocks"
              data-role="relation-group-blocks"
            >
              <div className="relation-group-header">
                <span className="relation-group-dot" />
                <span className="relation-group-label">
                  BLOCKS · {groups.blocksLinks.length}
                </span>
              </div>
              <div className="relation-group-rows">
                <RecursiveChildrenTree
                  parentId={task.id}
                  allTasks={safeTasks}
                  variant="detail"
                  nodes={toTreeNodes(groups.blocksLinks)}
                  onOpen={(child) => onOpenTask?.(child)}
                  onRemove={makeRemoveByTaskId(groups.blocksLinks)}
                  dragIntent={treeIntent}
                  onTreeIntent={handleTreeIntent}
                />
              </div>
            </div>
          )}

          {/* ── RELATED group ── */}
          {groups.relatesLinks.length > 0 && (
            <div
              className="relation-group relation-group--relates"
              data-role="relation-group-relates"
            >
              <div className="relation-group-header">
                <span className="relation-group-dot" />
                <span className="relation-group-label">
                  RELATED · {groups.relatesLinks.length}
                </span>
              </div>
              <div className="relation-group-rows">
                <RecursiveChildrenTree
                  parentId={task.id}
                  allTasks={safeTasks}
                  variant="detail"
                  nodes={toTreeNodes(groups.relatesLinks)}
                  onOpen={(child) => onOpenTask?.(child)}
                  onRemove={makeRemoveByTaskId(groups.relatesLinks)}
                  dragIntent={treeIntent}
                  onTreeIntent={handleTreeIntent}
                />
              </div>
            </div>
          )}

          {/* ── Empty state: just show the add button ── */}
          {allGroupsEmpty && !adding && (
            <div className="relations-area-empty">No relations yet</div>
          )}

          {/* ── + Add relation (last row inside body) ── */}
          {!adding && (
            <button
              className="relations-add-btn"
              data-role="relations-add"
              onClick={() => {
                setAdding(true);
                expand();
              }}
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
      )}
    </div>
  );
}

/* ── Inline helpers ───────────────────────────────────────────────────────── */

/**
 * Map flat relation rows to tree nodes. Resolved targets render as rows
 * (with guides/dots/DnD like every other group); dangling links render as
 * "(untitled)" placeholder rows so the Remove action stays reachable.
 */
function toTreeNodes(rows: DetailRelationRow[]): Task[] {
  return (rows ?? [])
    .filter((r) => r?.link?.taskId)
    .map(
      (r) =>
        r.target ?? {
          id: r.link.taskId,
          title: "(untitled)",
          status: "todo",
        },
    );
}
