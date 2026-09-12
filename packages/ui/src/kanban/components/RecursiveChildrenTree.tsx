import React, { useMemo } from "react";
import type { Task } from "../types";
import {
  getChildren,
  getDescendants,
  classifyTreeRowIntent,
  canReparent,
  dragSession,
} from "../task-links";
import type { DropIntent } from "../task-links";
import { compareTaskOrder } from "../utils";
import { ChildRow } from "./ChildRow";
import { MAX_TREE_DEPTH, TREE_INDENT_PX } from "./tree-constants";

// Public API (re-exported by the kanban index) — defined in tree-constants so
// ChildRow can read the indent step without a circular import.
export { MAX_TREE_DEPTH, TREE_INDENT_PX } from "./tree-constants";

interface RecursiveChildrenTreeProps {
  /** The parent whose children to render. */
  parentId: string;
  /** Full task list (used to resolve children at each level). */
  allTasks: Task[];
  /** Current nesting depth — used for indentation. */
  depth?: number;
  /** Cycle guard — pass the same Set across a tree to prevent infinite loops. */
  visited?: Set<string>;
  /** Visual variant forwarded to ChildRow. */
  variant?: "inline" | "detail";
  /** Callback when a child row is clicked. */
  onOpen?: (task: Task) => void;
  /** Callback to remove the parent link for a child. When provided, ChildRow renders a hover × button. */
  onRemove?: (taskId: string) => void;
  /** Tooltip for the ChildRow Unlink button (flat relation groups override the children wording). */
  removeTitle?: string;
  /** Max depth — cycle/pathology failsafe. Defaults to MAX_TREE_DEPTH. */
  maxDepth?: number;
  /**
   * Leaf-list mode: render `nodes` as flat rows — never recurse into a node's
   * subtree and never show the depth-limit summary. Used by the detail panel's
   * PARENTS / BLOCKS / RELATED groups, whose nested tasks are not part of the
   * open task's relations.
   */
  flat?: boolean;
  /**
   * Explicit-nodes mode: render the given tasks as depth-1 rows instead of
   * resolving getChildren(parentId). Used for the flat relation groups
   * (parent/blocks/relates) so every group shares the one tree component.
   * Nesting below each node still resolves via getChildren where applicable.
   */
  nodes?: Task[];
  /** Current tree drop intent — drives the insertion line + row highlight. */
  dragIntent?: DropIntent | null;
  /** Called when a row dragover (or root-gap dragover) classifies a new intent. */
  onTreeIntent?: (intent: DropIntent | null) => void;
  /** Extra dragstart hook (the tree always begins the dragSession itself). */
  onRowDragStart?: (e: React.DragEvent, childId: string) => void;
  /** Extra drop hook per row — drops also bubble to the column/section handler. */
  onRowDrop?: (e: React.DragEvent, childId: string) => void;
  /** Reactive drag-active flag — replaces render-time dragSession.get() reads. */
  isDragging?: boolean;
}

/**
 * Recursively renders the full subtree under a parent task.
 * Each child that itself has children renders its own nested sub-zone
 * (indented, with its own spine segment and status dots).
 *
 * Cycle-safe (visited set), dangling-safe (skip missing tasks),
 * memoized per parent+allTasks for performance.
 */
export const RecursiveChildrenTree = React.memo(function RecursiveChildrenTree({
  parentId,
  allTasks,
  depth = 0,
  visited,
  variant = "inline",
  onOpen,
  onRemove,
  removeTitle,
  maxDepth = MAX_TREE_DEPTH,
  flat,
  nodes,
  dragIntent,
  onTreeIntent,
  onRowDragStart,
  onRowDrop,
  isDragging,
}: RecursiveChildrenTreeProps) {
  const safeTasks = allTasks ?? [];
  const derivedChildren = useMemo(
    () => getChildren(safeTasks, parentId),
    [safeTasks, parentId],
  );

  const safeVisited = useMemo(() => {
    if (visited) return visited;
    return new Set<string>();
  }, [visited]);

  // Explicit-nodes mode renders the given tasks as depth-1 rows;
  // otherwise resolve children of parentId. Null entries are dropped.
  const baseList = nodes ?? derivedChildren;

  // Filter out cycle targets and missing tasks, then sort by kanban order (sortKey → createdAt)
  const validChildren = useMemo(() => {
    const filtered = (baseList ?? []).filter((c) => {
      if (!c?.id) return false;
      if (safeVisited.has(c.id)) return false;
      return true;
    });
    return [...filtered].sort(compareTaskOrder);
  }, [baseList, safeVisited]);

  /** Set of all task IDs for orphan detection. */
  const taskIdSet = useMemo(
    () => new Set(safeTasks.map((t) => t?.id).filter(Boolean)),
    [safeTasks],
  );

  // Row-level DnD handlers — stable across renders for the whole subtree level.
  const handleRowDragStart = React.useCallback(
    (e: React.DragEvent, childId: string) => {
      if (!childId) return;
      dragSession.begin(childId);
      onRowDragStart?.(e, childId);
    },
    [onRowDragStart],
  );

  const handleRowDragOver = React.useCallback(
    (e: React.DragEvent, childId: string) => {
      if (!onTreeIntent || !childId) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const intent = classifyTreeRowIntent(
        rect,
        e.clientY,
        { id: childId },
        parentId,
      );
      if (!intent) return;
      onTreeIntent(intent);
    },
    [onTreeIntent, safeTasks, parentId],
  );

  const handleRootDragOver = React.useCallback(
    (e: React.DragEvent) => {
      // Gap fallback: rows stopPropagation, so reaching here means the cursor
      // is between rows — surface a zone intent (append-last under parentId).
      if (!onTreeIntent) return;
      e.preventDefault();
      e.stopPropagation();
      const draggedId = dragSession.get();
      if (!draggedId) return;
      if (!canReparent(safeTasks, draggedId, parentId)) return;
      onTreeIntent({ kind: "zone", parentId });
    },
    [onTreeIntent, safeTasks, parentId],
  );

  // First-child slot dragover — same zone intent + validation as the gap
  // fallback above, so dropping on the slot follows the existing
  // onLinkChild / onTreeReparent path via the column/section handler.
  const handleEmptySlotDragOver = React.useCallback(
    (e: React.DragEvent) => {
      if (!onTreeIntent || !parentId) return;
      e.preventDefault();
      e.stopPropagation();
      const draggedId = dragSession.get();
      if (!draggedId) return;
      if (!canReparent(safeTasks, draggedId, parentId)) return;
      onTreeIntent({ kind: "zone", parentId });
    },
    [onTreeIntent, safeTasks, parentId],
  );

  // Mark this parent as visited for deeper recursion. Hoisted above the
  // empty early-return: a tree that gains/loses its last child must keep
  // a stable hook count across renders (else "more hooks than previous").
  const childVisited = useMemo(() => {
    const next = new Set(safeVisited);
    next.add(parentId);
    return next;
  }, [safeVisited, parentId]);

  if (validChildren.length === 0) {
    // Childless tree: render nothing when idle (zero layout/visual change),
    // a dashed first-child drop slot while a drag session is active.
    // Null-guarded: missing parentId or no dragged id renders nothing.
    if (!parentId) return null;
    if (!isDragging) return null;
    const showSlotHighlight =
      dragIntent?.kind === "zone" && dragIntent.parentId === parentId;
    return (
      <div
        className={`empty-child-slot${showSlotHighlight ? " empty-child-slot--drop-target" : ""}`}
        data-role="empty-child-slot"
        data-parent-id={parentId}
        data-drop-target={showSlotHighlight || undefined}
        onDragOver={handleEmptySlotDragOver}
        onClick={(e) => e.stopPropagation()}
      >
        Drop to add as first child
      </div>
    );
  }

  const dndActive = Boolean(onTreeIntent);

  return (
    <div
      className="recursive-children-tree"
      data-role="recursive-tree"
      onDragOver={dndActive ? handleRootDragOver : undefined}
    >
      {validChildren.map((child) => {
        if (!child?.id) return null;
        const childCount = getChildren(safeTasks, child.id).length;
        const childHasChildren = childCount > 0;
        const atMaxDepth = depth + 1 >= maxDepth;

        // Orphan detection: parent link points at a task not in allTasks
        const parentLink = child.links?.find((l) => l?.type === "parent");
        const isOrphan = Boolean(
          parentLink && !taskIdSet.has(parentLink.taskId),
        );

        // Insertion indicator: sibling line BETWEEN nodes, never inside rows
        // (keeps the row geometry used for band classification intact).
        const showLineBefore =
          dragIntent?.kind === "tree-row" &&
          dragIntent.targetId === child.id &&
          dragIntent.position === "before";
        const showLineAfter =
          dragIntent?.kind === "tree-row" &&
          dragIntent.targetId === child.id &&
          dragIntent.position === "after";
        // Center intent (zone make-child of this row) highlights the node.
        const showCenterHighlight =
          dragIntent?.kind === "zone" && dragIntent.parentId === child.id;

        return (
          <React.Fragment key={child.id}>
            {showLineBefore && (
              <div
                className="tree-drop-line"
                data-role="tree-drop-line"
                data-position="before"
                data-task-id={child.id}
              />
            )}
            <div
              key={child.id}
              className={`recursive-children-tree-node${showCenterHighlight ? " tree-node--drop-target" : ""}`}
              data-role="recursive-tree-node"
              data-depth={depth + 1}
              data-drop-target={showCenterHighlight || undefined}
            >
              {/* Indent wrapper — kept plain (no padding): indentation now comes
                from the flat per-depth left padding inside ChildRow. The wrapper
                is retained as the anchor for the opacity-ramp selectors
                (`.recursive-children-tree-node … > div > .child-link-row`) */}
              <div>
                <ChildRow
                  child={child}
                  variant={variant}
                  depth={depth + 1}
                  onOpen={() => onOpen?.(child)}
                  isOrphan={isOrphan}
                  childCount={childCount}
                  onRemove={onRemove}
                  removeTitle={removeTitle}
                  // A rendered row always represents a task, so it is always a
                  // drag source. `dndActive` only decides whether this tree
                  // accepts drop *intents* (the flat relation groups in the
                  // detail panel deliberately do not) — gating the source on it
                  // left those rows inert: no dragstart, no dragSession entry,
                  // so a drag from them could never resolve a target.
                  onRowDragStart={handleRowDragStart}
                  onRowDragOver={dndActive ? handleRowDragOver : undefined}
                  onRowDrop={dndActive ? onRowDrop : undefined}
                />
              </div>
              {!flat && childHasChildren && atMaxDepth && (
                <div
                  className="tree-depth-limit"
                  data-role="tree-depth-limit"
                  style={
                    variant === "inline" || variant === "detail"
                      ? { paddingLeft: (depth + 2) * TREE_INDENT_PX }
                      : undefined
                  }
                >
                  … {getDescendants(safeTasks, child.id).length} more
                </div>
              )}
              {!flat && childHasChildren && !atMaxDepth && (
                <div className="child-tree-nested">
                  <RecursiveChildrenTree
                    parentId={child.id}
                    allTasks={safeTasks}
                    depth={depth + 1}
                    visited={childVisited}
                    variant={variant}
                    onOpen={onOpen}
                    onRemove={onRemove}
                    removeTitle={removeTitle}
                    maxDepth={maxDepth}
                    dragIntent={dragIntent}
                    onTreeIntent={onTreeIntent}
                    onRowDragStart={onRowDragStart}
                    onRowDrop={onRowDrop}
                    isDragging={isDragging}
                  />
                </div>
              )}
            </div>
            {showLineAfter && (
              <div
                className="tree-drop-line"
                data-role="tree-drop-line"
                data-position="after"
                data-task-id={child.id}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
});
