// ── Task link helpers (pure, no I/O) ─────────────────────────────────────
import type { Task, TaskLinkType } from "./types.js";

/** Canonical status colors — single source of truth for dots/badges.
 * Matches the UI dp-status-btn.active-* text colors in kanban.css. */
export const STATUS_COLORS: Record<string, string> = {
  backlog: "#94a3b8",
  todo: "#f59e0b",
  "in-progress": "#60a5fa",
  review: "#a855f7",
  done: "#22c55e",
};

/** Status → color mapping for dots/badges. */
export function getStatusColor(status?: string): string {
  return STATUS_COLORS[status ?? ""] ?? STATUS_COLORS.todo;
}

/** Return all children of a task (tasks that have a 'parent' link pointing to this task). */
export function getChildren(tasks: Task[], parentId: string): Task[] {
  return tasks.filter((t) =>
    t.links?.some((l) => l.type === "parent" && l.taskId === parentId),
  );
}

/** Return the parent task of a task (the task this task has a 'parent' link to), or undefined. */
export function getParent(tasks: Task[], taskId: string): Task | undefined {
  const task = tasks.find((t) => t.id === taskId);
  const parentLink = task?.links?.find((l) => l.type === "parent");
  if (!parentLink) return undefined;
  return tasks.find((t) => t.id === parentLink.taskId);
}

/** Walk the parent chain from `startId` upward. Returns ids visited (excluding startId). */
function walkParentChain(
  tasks: Task[],
  startId: string,
  maxDepth = 100,
): string[] {
  const visited: string[] = [];
  let currentId = startId;
  for (let i = 0; i < maxDepth; i++) {
    const task = tasks.find((t) => t.id === currentId);
    const parentLink = task?.links?.find((l) => l.type === "parent");
    if (!parentLink) break;
    visited.push(parentLink.taskId);
    currentId = parentLink.taskId;
  }
  return visited;
}

export interface LinkValidationError {
  ok: false;
  reason: string;
}

export interface LinkValidationOk {
  ok: true;
}

export type LinkValidationResult = LinkValidationError | LinkValidationOk;

/** Validate a proposed link addition. Returns {ok:false, reason} on rejection. */
export function validateLinkAddition({
  allTasks,
  fromId,
  toId,
  type,
}: {
  allTasks: Task[];
  fromId: string;
  toId: string;
  type: TaskLinkType;
}): LinkValidationResult {
  const fromTask = allTasks.find((t) => t.id === fromId);
  const toTask = allTasks.find((t) => t.id === toId);

  if (!fromTask) return { ok: false, reason: `Task ${fromId} not found` };
  if (!toTask) return { ok: false, reason: `Task ${toId} not found` };
  if (fromId === toId)
    return { ok: false, reason: "Cannot link a task to itself" };

  // Check duplicate
  const existing = fromTask.links?.find(
    (l) => l.taskId === toId && l.type === type,
  );
  if (existing) {
    return {
      ok: false,
      reason: `Link already exists: ${fromId} --[${type}]--> ${toId}`,
    };
  }

  // If adding a 'parent' link, ensure the task doesn't already have a parent
  if (type === "parent") {
    const existingParent = fromTask.links?.find((l) => l.type === "parent");
    if (existingParent) {
      return {
        ok: false,
        reason: `Task ${fromId} already has a parent (${existingParent.taskId}). Remove it first.`,
      };
    }
  }

  // Cycle detection: if adding parent link fromId -> toId, check if toId can reach fromId via parent chain
  if (type === "parent") {
    const ancestors = walkParentChain(allTasks, toId);
    if (ancestors.includes(fromId)) {
      return {
        ok: false,
        reason: `Cycle detected: ${toId} is already a descendant of ${fromId}`,
      };
    }
  }

  return { ok: true };
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
 * - groups: rootId → direct children (level 1 only)
 */
export interface TaskGrouping {
  standalone: Task[];
  groups: Map<string, Task[]>;
}
export function groupTasksByRoot(tasks: Task[]): TaskGrouping {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const standalone: Task[] = [];
  const groups = new Map<string, Task[]>();

  for (const task of tasks) {
    const root = resolveRootTask(tasks, task.id);
    if (root === task.id) {
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
      standalone.push(task);
    }
  }

  return { standalone, groups };
}

/** Check whether dragging draggedId onto targetId as a child is valid.
 * Rejects self-links, cycles (target is a descendant of dragged),
 * and already-parented tasks (dragged task already has a parent link). */
export function targetValid(
  allTasks: Task[],
  draggedId: string,
  targetId: string,
): boolean {
  if (draggedId === targetId) return false;
  const descendants = getDescendants(allTasks, draggedId);
  if (descendants.includes(targetId)) return false;
  // Reject if dragged task already has a parent (single-parent rule)
  const draggedTask = allTasks.find((t) => t.id === draggedId);
  if (draggedTask?.links?.some((l) => l.type === "parent")) return false;
  return true;
}

// ── Derived relations view (CLI display + MCP ergonomics) ────────────────

/** Return all tasks that block `taskId` via a 'blocks' link on the blocked task.
Semantics: a 'blocks' link on task T means X blocks T; getBlockers returns those X's.
Dangling link targets are dropped (not an error). */
export function getBlockers(tasks: Task[], taskId: string): Task[] {
  return tasks
    .filter((t) =>
      t.links?.some((l) => l.type === "blocks" && l.taskId === taskId),
    )
    .filter((t): t is Task => t !== undefined);
}

// ── Derived relations view (CLI display + MCP ergonomics) ────────────────

export interface TaskRelationsRef {
  id: string;
  title: string;
  status?: string;
}

export interface TaskRelationsView {
  parent: TaskRelationsRef | null;
  children: TaskRelationsRef[];
  others: Array<{ type: "relates" | "blocks"; id: string; title: string }>;
}

/** Derive a relations view for a task from a full task list. */
export function taskRelations(
  allTasks: Task[],
  taskId: string,
): TaskRelationsView {
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) return { parent: null, children: [], others: [] };

  // Parent: the task we point at
  const parentLink = task.links?.find((l) => l.type === "parent");
  const parent = parentLink
    ? (() => {
        const p = allTasks.find((t) => t.id === parentLink.taskId);
        return p
          ? { id: p.id, title: p.title, status: p.status }
          : { id: parentLink.taskId, title: "(not found)" };
      })()
    : null;

  // Children: tasks pointing at us
  const children: TaskRelationsRef[] = allTasks
    .filter((t) =>
      t.links?.some((l) => l.type === "parent" && l.taskId === taskId),
    )
    .map((t) => ({ id: t.id, title: t.title, status: t.status }));

  // Others: non-parent links
  const others = (task.links ?? [])
    .filter((l) => l.type !== "parent")
    .map((l) => {
      const target = allTasks.find((t) => t.id === l.taskId);
      return {
        type: l.type as "relates" | "blocks",
        id: l.taskId,
        title: target?.title ?? "(not found)",
      };
    });

  return { parent, children, others };
}

/** Format relations as dim CLI display lines. Cap children at 3. */
export function formatRelationsSummary(view: TaskRelationsView): string[] {
  const lines: string[] = [];
  const shortId = (id: string) => id.slice(0, 8);
  const trunc = (s: string, max = 40) =>
    s.length > max ? s.slice(0, max - 1) + "…" : s;

  if (view.parent) {
    lines.push(
      `parent:   ${shortId(view.parent.id)} ${trunc(view.parent.title)}`,
    );
  }

  if (view.children.length > 0) {
    const shown = view.children.slice(0, 3);
    const parts = shown.map((c) => `${shortId(c.id)} ${trunc(c.title)}`);
    const remaining = view.children.length - 3;
    if (remaining > 0) parts.push(`…and ${remaining} more`);
    lines.push(`children: ${view.children.length} — ${parts.join(", ")}`);
  }

  for (const o of view.others) {
    const label = o.type === "relates" ? "related" : "blocked";
    lines.push(`${label}:  ${o.type} → ${shortId(o.id)} ${trunc(o.title)}`);
  }

  return lines;
}
