import { useState, useCallback, useRef, useEffect } from "react";
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
import type { DropIntent } from "../task-links";
import { TASK_LINK_TYPES } from "../types";
import { compareTaskOrder } from "../utils";
import { RecursiveChildrenTree } from "./RecursiveChildrenTree";
import { RemoveLinkDialog } from "./RemoveLinkDialog";

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
  /** Called when the user confirms detach (move-up or delete-children). */
  onDetach?: (taskId: string, deleteChildren: boolean) => void;
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
 * Detail-panel Relations section — always expanded, non-collapsible.
 * Renders the header row (title + flat count chips, no toggle/chevron),
 * the CHILDREN group tree (same chevron + title + flat-indent row
 * rendering as the card zone), plus the relation search/add UI.
 */
export default function RelationsSection({
  task,
  allTasks,
  onUpdateLinks,
  onOpenTask,
  onTreeReorder,
  onTreeReparent,
  onDetach,
}: RelationsSectionProps) {
  const [adding, setAdding] = useState(false);
  const [linkType, setLinkType] = useState<TaskLinkType>("relates");
  const [search, setSearch] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<{
    childId: string;
    childTitle: string;
    childCount: number;
  } | null>(null);

  // Tree DnD intent — shared by the children tree in this section.
  // The dragged id travels via the dragSession singleton (no prop-drilling).
  const [treeIntent, setTreeIntent] = useState<DropIntent | null>(null);
  const treeIntentRef = useRef<DropIntent | null>(null);
  // Local drag mirror: the detail panel sits outside the board's drag state,
  // so window dragstart/dragend drives the empty-group slot visibility.
  // Rendered output is unchanged when idle (group stays hidden when empty).
  const [panelDragActive, setPanelDragActive] = useState(false);
  useEffect(() => {
    const onStart = () => {
      if (dragSession.get()) setPanelDragActive(true);
    };
    const onEnd = () => setPanelDragActive(false);
    window.addEventListener("dragstart", onStart);
    window.addEventListener("dragend", onEnd);
    window.addEventListener("drop", onEnd);
    return () => {
      window.removeEventListener("dragstart", onStart);
      window.removeEventListener("dragend", onEnd);
      window.removeEventListener("drop", onEnd);
    };
  }, []);
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

  const handleRemove = useCallback(
    (idx: number) => {
      const newLinks = links.filter((_, i) => i !== idx);
      onUpdateLinks(newLinks);
    },
    [links, onUpdateLinks],
  );

  const handleRemoveChildLink = useCallback(
    (childId: string) => {
      const child = safeTasks.find((t) => t.id === childId);
      const childChildren = getChildren(safeTasks, childId);
      setConfirmRemove({
        childId,
        childTitle: child?.title ?? childId,
        childCount: childChildren.length,
      });
    },
    [safeTasks],
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
      setPanelDragActive(false);
    },
    [safeTasks, onTreeReorder, onTreeReparent],
  );

  const handleTreeDragEnd = useCallback(() => {
    dragSession.end();
    treeIntentRef.current = null;
    setTreeIntent(null);
    setPanelDragActive(false);
  }, []);

  return (
    <div className="relations-section" data-role="relations-area">
      {/* ── Header (no toggle, no chevron) with summary chips ── */}
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
      </div>

      {/* ── CHILDREN group — always visible when non-empty, non-collapsible.
          When empty it stays hidden while idle, and renders the first-child
          drop slot while a drag session is active (same zone-intent path). ── */}
      {(groups.children.length > 0 ||
        panelDragActive ||
        dragSession.get() != null) && (
        <div
          className="relation-group relation-group--children"
          data-role="relation-group-children"
          onDrop={handleTreeDrop}
          onDragEnd={handleTreeDragEnd}
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

      <RemoveLinkDialog
        open={confirmRemove !== null}
        childTitle={confirmRemove?.childTitle ?? ""}
        childCount={confirmRemove?.childCount ?? 0}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={(deleteChildren) => {
          if (!confirmRemove) return;
          if (onDetach) {
            onDetach(confirmRemove.childId, deleteChildren);
          } else {
            // Fallback: direct link removal (no server detach)
            const idx = links.findIndex(
              (l) => l?.type === "parent" && l?.taskId === confirmRemove.childId,
            );
            if (idx >= 0) handleRemove(idx);
          }
          setConfirmRemove(null);
        }}
      />
    </div>
  );
}
