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
import type { DetailRelationRow, DropIntent } from "../task-links";
import { TASK_LINK_TYPES } from "../types";
import { compareTaskOrder } from "../utils";
import { RecursiveChildrenTree } from "./RecursiveChildrenTree";
import { ConfirmModal } from "./ConfirmModal";

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
  /** Called when the user confirms unlink (removes parent link, never deletes). */
  onDetach?: (taskId: string) => void;
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
 * one group body per non-empty relation type — CHILDREN as a recursive tree
 * (same chevron + title + flat-indent row rendering as the card zone),
 * PARENTS / BLOCKS / RELATED as flat rows (see FlatRelationGroup) — plus the
 * relation search/add UI.
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
      try {
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
      } finally {
        // A drop is terminal: release the session/intent on EVERY path — a
        // missing intent or a rejected reparent must not leave the panel (and
        // the dragSession singleton the board reads) holding a live drag.
        dragSession.end();
        treeIntentRef.current = null;
        setTreeIntent(null);
        setPanelDragActive(false);
      }
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
      {(groups.children.length > 0 || panelDragActive) && (
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
              isDragging={panelDragActive}
            />
          </div>
        </div>
      )}

      {/* ── PARENTS group — this task's explicit "child of" links, flat rows ── */}
      {groups.parentLinks.length > 0 && (
        <FlatRelationGroup
          kind="parent"
          label="PARENTS"
          parentId={task.id}
          allTasks={safeTasks}
          rows={groups.parentLinks}
          onOpen={onOpenTask}
          onRemoveLink={handleRemove}
        />
      )}

      {/* ── BLOCKS group — flat rows ── */}
      {groups.blocksLinks.length > 0 && (
        <FlatRelationGroup
          kind="blocks"
          label="BLOCKS"
          parentId={task.id}
          allTasks={safeTasks}
          rows={groups.blocksLinks}
          onOpen={onOpenTask}
          onRemoveLink={handleRemove}
        />
      )}

      {/* ── RELATED group — flat rows ── */}
      {groups.relatesLinks.length > 0 && (
        <FlatRelationGroup
          kind="relates"
          label="RELATED"
          parentId={task.id}
          allTasks={safeTasks}
          rows={groups.relatesLinks}
          onOpen={onOpenTask}
          onRemoveLink={handleRemove}
        />
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

      <ConfirmModal
        open={confirmRemove !== null}
        title="Unlink child?"
        message={
          confirmRemove?.childCount ? (
            <>
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  color: "var(--p-text-f)",
                  lineHeight: 1.6,
                }}
              >
                Unlink{" "}
                <strong style={{ color: "var(--p-text)" }}>
                  &ldquo;{confirmRemove.childTitle}&rdquo;
                </strong>
                ?
              </p>
              <p
                style={{
                  margin: "8px 0 0",
                  fontSize: 12,
                  color: "var(--p-text-m)",
                  lineHeight: 1.5,
                }}
              >
                Its {confirmRemove.childCount}{" "}
                {confirmRemove.childCount === 1
                  ? "child moves"
                  : "children move"}{" "}
                up one level.
              </p>
            </>
          ) : (
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: "var(--p-text-f)",
                lineHeight: 1.6,
              }}
            >
              Unlink{" "}
              <strong style={{ color: "var(--p-text)" }}>
                &ldquo;{confirmRemove?.childTitle}&rdquo;
              </strong>
              ? It will become a root task.
            </p>
          )
        }
        confirmLabel="Unlink"
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          if (!confirmRemove) return;
          if (onDetach) {
            onDetach(confirmRemove.childId);
          } else {
            // Fallback: direct link removal (no server detach)
            const idx = links.findIndex(
              (l) =>
                l?.type === "parent" && l?.taskId === confirmRemove.childId,
            );
            if (idx >= 0) handleRemove(idx);
          }
          setConfirmRemove(null);
        }}
      />
    </div>
  );
}

/* ── Inline helpers ───────────────────────────────────────────────────────── */

interface FlatRelationGroupProps {
  /** Non-children relation type — drives the data-role and colour modifier. */
  kind: "parent" | "blocks" | "relates";
  /** Uppercase group label (plural, matches the summary chip wording). */
  label: string;
  /** The open task's id — vestigial parent for the explicit-nodes tree. */
  parentId: string;
  /** Full task list — row rendering needs it (dangling links, child counts). */
  allTasks: Task[];
  /** That type's rows, with the original link index needed for removal. */
  rows: DetailRelationRow[];
  onOpen?: (task: Task) => void;
  /** Removes the link at its original index in `task.links`. */
  onRemoveLink: (linkIndex: number) => void;
}

/**
 * PARENTS / BLOCKS / RELATED group body.
 *
 * Reuses the one tree component (RecursiveChildrenTree) in explicit-nodes mode
 * with `flat`, so the group renders leaf rows: a blocks/relates target's own
 * subtree is not part of this task's relations, and recursing the PARENTS
 * group would render this task's siblings under each parent. No drag intent is
 * passed, so these rows are plain links — drag-reparenting only has meaning
 * inside the CHILDREN tree.
 */
function FlatRelationGroup({
  kind,
  label,
  parentId,
  allTasks,
  rows,
  onOpen,
  onRemoveLink,
}: FlatRelationGroupProps) {
  const nodes = toTreeNodes(rows);

  const handleRemove = useCallback(
    (taskId: string) => {
      const row = rows.find((r) => r?.link?.taskId === taskId);
      if (row) onRemoveLink(row.linkIndex);
    },
    [rows, onRemoveLink],
  );

  return (
    <div
      className={`relation-group relation-group--${kind}`}
      data-role={`relation-group-${kind}`}
    >
      <div className="relation-group-header">
        <span className="relation-group-dot" />
        <span className="relation-group-label">
          {label} · {rows.length}
        </span>
      </div>
      <div className="relation-group-rows">
        <RecursiveChildrenTree
          parentId={parentId}
          allTasks={allTasks}
          variant="detail"
          flat
          nodes={nodes}
          onOpen={onOpen}
          onRemove={handleRemove}
          removeTitle="Unlink this relation"
        />
      </div>
    </div>
  );
}

/**
 * Map flat relation rows to tree nodes. Resolved targets render as rows;
 * dangling links render as a "(missing <id>)" placeholder so the row (and its
 * Unlink action) stays reachable.
 */
function toTreeNodes(rows: DetailRelationRow[]): Task[] {
  return (rows ?? [])
    .filter((r) => r?.link?.taskId)
    .map(
      (r) =>
        r.target ?? {
          id: r.link.taskId,
          title: `(missing ${shortId(r.link.taskId)})`,
          status: "todo",
        },
    );
}
