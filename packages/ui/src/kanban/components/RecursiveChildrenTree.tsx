import React, { useMemo } from "react";
import type { Task } from "../types";
import { getChildren, getDescendants } from "../task-links";
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
  /** Max depth — stops recursion beyond this level (0 = no limit). */
  /** Max depth — cycle/pathology failsafe. Defaults to MAX_TREE_DEPTH. */
  maxDepth?: number;
}

/**
 * Recursively renders the full subtree under a parent task.
 * Each child that itself has children renders its own nested sub-zone
 * (indented, with its own dotted spine segment and status dots).
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

  // Filter out cycle targets and missing tasks
  const validChildren = useMemo(() => {
    return children.filter((c) => {
      if (safeVisited.has(c.id)) return false;
      return true;
    });
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
      {validChildren.map((child) => {
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
            <div
              style={
                variant === "inline"
                  ? { paddingLeft: (depth + 1) * TREE_INDENT_PX }
                  : undefined
              }
            >
              <ChildRow
                child={child}
                variant={variant}
                onOpen={() => onOpen?.(child)}
                isOrphan={isOrphan}
                childCount={childCount}
              />
            </div>
            {childHasChildren && atMaxDepth && (
              <div
                className="tree-depth-limit"
                data-role="tree-depth-limit"
                style={
                  variant === "inline"
                    ? { paddingLeft: (depth + 2) * TREE_INDENT_PX }
                    : undefined
                }
              >
                … {getDescendants(allTasks, child.id).length} more
              </div>
            )}
            {childHasChildren && !atMaxDepth && (
              <RecursiveChildrenTree
                parentId={child.id}
                allTasks={allTasks}
                depth={depth + 1}
                visited={childVisited}
                variant={variant}
                onOpen={onOpen}
                maxDepth={maxDepth}
              />
            )}
            {childHasChildren && atMaxDepth && (
              <div
                className="recursive-tree-overflow"
                data-role="recursive-tree-overflow"
                data-depth={depth + 2}
                style={{
                  paddingLeft: (depth + 2) * TREE_INDENT_PX,
                  fontSize: 12,
                  color: "var(--p-text-f, #64748b)",
                  fontStyle: "italic",
                  padding: `3px 0 3px ${(depth + 2) * TREE_INDENT_PX}px`,
                }}
              >
                … {(() => {
                  const remaining = getDescendants(allTasks, child.id).length;
                  return remaining > 0
                    ? `${remaining} more items`
                    : "deeper levels";
                })()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});
