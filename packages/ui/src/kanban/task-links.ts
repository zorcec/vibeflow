// ── Task link helpers (pure, mirrors CLI task-links.ts) ──────────────────
import type { Task, TaskLink, TaskLinkType } from "./types";

/** Return all children of a task. */
export function getChildren(tasks: Task[], parentId: string): Task[] {
  return tasks.filter((t) =>
    t.links?.some((l) => l.type === "parent" && l.taskId === parentId),
  );
}

/** Return the parent task, or undefined. */
export function getParent(tasks: Task[], taskId: string): Task | undefined {
  const task = tasks.find((t) => t.id === taskId);
  const parentLink = task?.links?.find((l) => l.type === "parent");
  if (!parentLink) return undefined;
  return tasks.find((t) => t.id === parentLink.taskId);
}

/** Get the short 7-char id for display. */
export function shortId(id: string): string {
  return id.slice(0, 7);
}

/** Status → color mapping for dots/badges. */
export function getStatusColor(status?: string): string {
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

/** Return all tasks that block this task via a 'blocks' link on the blocked task.
Semantics: a 'blocks' link on task T means X blocks T; getBlockers returns those X's.
Dangling link targets are dropped (not an error). */
export function getBlockers(tasks: Task[], taskId: string): Task[] {
  return tasks
    .filter((t) =>
      t.links?.some((l) => l.type === "blocks" && l.taskId === taskId),
    )
    .filter((t): t is Task => t !== undefined);
}

/** Walk parent chain upward to find the top-most ancestor. Cycle-safe (visited-set). */
export function resolveRootTask(tasks: Task[], taskId: string): string {
  const visited = new Set<string>();
  let current = taskId;
  while (!visited.has(current)) {
    visited.add(current);
    const parentLink = tasks
      .find((t) => t.id === current)
      ?.links?.find((l) => l.type === "parent");
    if (!parentLink) break;
    current = parentLink.taskId;
  }
  return current;
}

/** Return all descendant ids (children, grandchildren, …) cycle-safe. */
export function getDescendants(tasks: Task[], rootId: string): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const kids = tasks.filter((t) =>
      t.links?.some((l) => l.type === "parent" && l.taskId === id),
    );
    for (const kid of kids) {
      if (!visited.has(kid.id)) {
        visited.add(kid.id);
        result.push(kid.id);
        queue.push(kid.id);
      }
    }
  }
  return result;
}

/** Return descendants that have no children (leaf nodes). */
export function getLeafDescendants(tasks: Task[], rootId: string): Task[] {
  const allDescIds = getDescendants(tasks, rootId);
  return allDescIds
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined)
    .filter(
      (t) => !getChildren(tasks, t.id).some((c) => allDescIds.includes(c.id)),
    );
}

/**
 * Group tasks by their root ancestor.
 * - standalone: tasks with no parent, or whose root is not in the filtered list
 * - groups: rootId → leaf descendants (sorted by compareTaskOrder if provided)
 */
export interface TaskGrouping {
  standalone: Task[];
  groups: Map<string, Task[]>;
}
export function groupTasksByRoot(
  tasks: Task[],
  comparator?: (a: Task, b: Task) => number,
): TaskGrouping {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const standalone: Task[] = [];
  const groups = new Map<string, Task[]>();

  for (const task of tasks) {
    const root = resolveRootTask(tasks, task.id);
    if (root === task.id) {
      // This task is a root — goes into standalone
      standalone.push(task);
    } else if (taskMap.has(root)) {
      // Walk from task upward to root, ensuring intermediate
      // ancestors have group entries with their direct children.
      let current = task.id;
      while (current !== root) {
        const parentLink = tasks
          .find((t) => t.id === current)
          ?.links?.find((l) => l.type === "parent");
        if (!parentLink) break;
        const parentId = parentLink.taskId;
        if (!groups.has(parentId)) {
          const directChildren = getChildren(tasks, parentId);
          groups.set(
            parentId,
            directChildren.filter((c) => taskMap.has(c.id)),
          );
        }
        current = parentId;
      }
    } else {
      // Root not in filtered list — treat as standalone fallback
      standalone.push(task);
    }
  }

  // Sort groups
  if (comparator) {
    for (const [rootId, members] of groups) {
      groups.set(rootId, [...members].sort(comparator));
    }
    standalone.sort(comparator);
  }

  return { standalone, groups };
}

/** Classify a drop position within a card into top/bottom/center bands.
 * Top and bottom bands are 22% of height, clamped to [26px, 48px].
 * The remainder is center. */
export function classifyDropZone(
  rect: { top: number; height: number },
  clientY: number,
): "top" | "center" | "bottom" {
  const minBand = 26;
  const maxBand = 48;
  const rawBand = Math.floor(rect.height * 0.22);
  const band = Math.max(minBand, Math.min(maxBand, rawBand));
  if (clientY < rect.top + band) return "top";
  if (clientY > rect.top + rect.height - band) return "bottom";
  return "center";
}

/** Check whether dragging draggedId onto targetId as a child is valid.
 * Rejects self-links and cycles (target is a descendant of dragged). */
export function targetValid(
  allTasks: Task[],
  draggedId: string,
  targetId: string,
): boolean {
  if (draggedId === targetId) return false;
  const descendants = getDescendants(allTasks, draggedId);
  return !descendants.includes(targetId);
}

/** Position for a child popover anchored to a DOMRect. */
export interface PopoverPosition {
  top: number;
  left: number;
  width: number;
}

/**
 * Compute the fixed position for a popover anchored to a card rect.
 * Default: below the card, left-aligned with card.
 * Flip up when there's not enough space below.
 * Clamps to viewport edges.
 */
export function computePopoverPosition(
  r: DOMRect,
  estH: number,
  viewportHeight: number,
  viewportWidth: number,
): PopoverPosition {
  const W = Math.min(280, Math.max(200, r.width));
  const MARGIN = 6;
  const EDGE_PAD = 8;

  // Default: below card
  let top = r.bottom + MARGIN;
  // Flip up if not enough room below
  if (top + estH > viewportHeight - EDGE_PAD) {
    top = r.top - estH - MARGIN;
  }
  // Clamp to viewport top
  top = Math.max(EDGE_PAD, top);

  // Left-aligned with card, clamped to viewport
  const left = Math.max(
    EDGE_PAD,
    Math.min(r.left, viewportWidth - W - EDGE_PAD),
  );

  return { top, left, width: W };
}
