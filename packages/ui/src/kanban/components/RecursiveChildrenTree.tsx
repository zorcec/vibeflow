import React, { useMemo } from "react";
import type { Task } from "../types";
import { getChildren, getDescendants } from "../task-links";
import { compareTaskOrder } from "../utils";
import { ChildRow } from "./ChildRow";

/** Depth indentation per nesting level (px). */
export const TREE_INDENT_PX = 14;

/** Failsafe, not a design limit. */
export const MAX_TREE_DEPTH = 8;

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
  /** Max depth — cycle/pathology failsafe. Defaults to MAX_TREE_DEPTH. */
  maxDepth?: number;
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
  maxDepth = MAX_TREE_DEPTH,
}: RecursiveChildrenTreeProps) {
  const children = useMemo(
    () => getChildren(allTasks, parentId),
    [allTasks, parentId],
  );

  const safeVisited = useMemo(() => {
    if (visited) return visited;
    return new Set<string>();
  }, [visited]);

  // Filter out cycle targets and missing tasks, then sort by kanban order (sortKey → createdAt)
  const validChildren = useMemo(() => {
    const filtered = children.filter((c) => {
      if (safeVisited.has(c.id)) return false;
      return true;
    });
    return [...filtered].sort(compareTaskOrder);
  }, [children, safeVisited]);

  /** Set of all task IDs for orphan detection. */
  const taskIdSet = useMemo(
    () => new Set(allTasks.map((t) => t.id)),
    [allTasks],
  );

  if (validChildren.length === 0) return null;

  // Mark this parent as visited for deeper recursion
  const childVisited = useMemo(() => {
    const next = new Set(safeVisited);
    next.add(parentId);
    return next;
  }, [safeVisited, parentId]);

  return (
    <div className="recursive-children-tree" data-role="recursive-tree">
      {validChildren.map((child, index) => {
        const childCount = getChildren(allTasks, child.id).length;
        const childHasChildren = childCount > 0;
        const atMaxDepth = depth + 1 >= maxDepth;

        // Orphan detection: parent link points at a task not in allTasks
        const parentLink = child.links?.find((l) => l.type === "parent");
        const isOrphan = Boolean(
          parentLink && !taskIdSet.has(parentLink.taskId),
        );

        return (
          <div
            key={child.id}
            className="recursive-children-tree-node"
            data-role="recursive-tree-node"
            data-depth={depth + 1}
          >
            {/* Indent wrapper — kept plain (no padding): indentation now comes
                from the in-flow .tree-guides inside ChildRow. The wrapper is
                retained as the anchor for the opacity-ramp selectors
                (`.recursive-children-tree-node … > div > .child-link-row`) */}
            <div>
              <ChildRow
                child={child}
                variant={variant}
                depth={depth + 1}
                isLast={index === validChildren.length - 1}
                onOpen={() => onOpen?.(child)}
                isOrphan={isOrphan}
                childCount={childCount}
                onRemove={onRemove}
              />
            </div>
            {childHasChildren && atMaxDepth && (
              <div
                className="tree-depth-limit"
                data-role="tree-depth-limit"
                style={
                  variant === "inline" || variant === "detail"
                    ? { paddingLeft: (depth + 2) * TREE_INDENT_PX }
                    : undefined
                }
              >
                … {getDescendants(allTasks, child.id).length} more
              </div>
            )}
            {childHasChildren && !atMaxDepth && (
              <div className="child-tree-nested">
                <RecursiveChildrenTree
                  parentId={child.id}
                  allTasks={allTasks}
                  depth={depth + 1}
                  visited={childVisited}
                  variant={variant}
                  onOpen={onOpen}
                  onRemove={onRemove}
                  maxDepth={maxDepth}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});
