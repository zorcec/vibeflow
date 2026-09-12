// ── Task link helpers (pure, mirrors CLI task-links.ts) ──────────────────
import type { Task, TaskLinkType } from "./types";
import { compareTaskOrder, computeReorder, maxSortKey } from "./utils";
import type { ReorderPatch } from "./utils";

/** Canonical status colors — single source of truth for dots/badges.
 * Values match the DetailPanel dp-status-btn.active-* text colors. */
export const STATUS_COLORS: Record<string, string> = {
 backlog: "#94a3b8",
 todo: "#f59e0b",
 "in-progress": "#60a5fa",
 review: "#a855f7",
 done: "#22c55e",
};

/** Return all children of a task.
 * Null-entry safe: skips null/undefined tasks and null links so a single
 * corrupted entry in `tasks` can never blank the board during render (P0). */
export function getChildren(tasks: Task[], parentId: string): Task[] {
 return tasks.filter((t) =>
  t?.links?.some((l) => l?.type === "parent" && l?.taskId === parentId),
 );
}

/** Relation row as it appears in a detail-group with original link index for removal. */
export interface DetailRelationRow {
 target: Task | undefined;
 link: { taskId: string; type: TaskLinkType };
 linkIndex: number;
 isDerived: boolean;
}

export interface DetailRelationsGroups {
 children: Task[];
 parentLinks: DetailRelationRow[];
 blocksLinks: DetailRelationRow[];
 relatesLinks: DetailRelationRow[];
}

/**
 * Pure helper: split a task's relations into typed groups.
 * - children: derived via getChildren (no link index)
 * - parentLinks/blocksLinks/relatesLinks: explicit links with original indices.
 */
export function groupDetailRelations(
 task: Task,
 allTasks: Task[],
): DetailRelationsGroups {
 const links = task.links ?? [];
 const children = getChildren(allTasks, task.id);

 const parentLinks: DetailRelationRow[] = [];
 const blocksLinks: DetailRelationRow[] = [];
 const relatesLinks: DetailRelationRow[] = [];

 links.forEach((link, idx) => {
  if (!link) return;
  const target = allTasks.find((t) => t?.id === link.taskId);
  const row: DetailRelationRow = {
   target,
   link,
   linkIndex: idx,
   isDerived: false,
  };
  if (link.type === "parent") parentLinks.push(row);
  else if (link.type === "blocks") blocksLinks.push(row);
  else relatesLinks.push(row);
 });

 return { children, parentLinks, blocksLinks, relatesLinks };
}

/** Return the parent task, or undefined. */
export function getParent(tasks: Task[], taskId: string): Task | undefined {
 const task = tasks.find((t) => t?.id === taskId);
 const parentLink = task?.links?.find((l) => l?.type === "parent");
 if (!parentLink) return undefined;
 return tasks.find((t) => t?.id === parentLink.taskId);
}

/** Get the short 7-char id for display. */
export function shortId(id: string): string {
 return id.slice(0, 7);
}

/** Status → color mapping for dots/badges. */
export function getStatusColor(status?: string): string {
 return STATUS_COLORS[status ?? ""] ?? STATUS_COLORS.todo;
}

/** Return all tasks that block this task via a 'blocks' link on the blocked task.
Semantics: a 'blocks' link on task T means X blocks T; getBlockers returns those X's.
Dangling link targets are dropped (not an error). Null-entry safe (P0):
skips null/undefined tasks so `blockers.map((b) => b.title)` can never throw. */
export function getBlockers(tasks: Task[], taskId: string): Task[] {
 return tasks
  .filter((t) =>
   t?.links?.some((l) => l?.type === "blocks" && l?.taskId === taskId),
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
   .find((t) => t?.id === current)
   ?.links?.find((l) => l?.type === "parent");
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
   t?.links?.some((l) => l?.type === "parent" && l?.taskId === id),
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
  .map((id) => tasks.find((t) => t?.id === id))
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
 const taskMap = new Map(
  tasks.filter((t) => t?.id).map((t) => [t.id, t] as const),
 );
 const standalone: Task[] = [];
 const groups = new Map<string, Task[]>();

 for (const task of tasks) {
  if (!task?.id) continue; // null-entry safety (P0)
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
     .find((t) => t?.id === current)
     ?.links?.find((l) => l?.type === "parent");
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

/** Reorder-band geometry constants — exported for unit testing and reuse. */
export const DROP_BAND_RATIO = 0.28;
export const DROP_BAND_MIN_PX = 32;
export const DROP_BAND_MAX_PX = 56;

/** Tree-row specific bands — tree rows are ~22px tall, so the 32px
 *  card min band makes center (make-child) unreachable. */
export const TREE_DROP_BAND_MIN_PX = 5;
export const TREE_DROP_BAND_MAX_PX = 10;

/** Classify a drop position within a card into top/bottom/center bands.
 * Top and bottom bands are 28% of height, clamped to [32px, 56px].
 * The remainder is center. */
export function classifyDropZone(
 rect: { top: number; height: number },
 clientY: number,
): "top" | "center" | "bottom" {
 const rawBand = Math.floor(rect.height * DROP_BAND_RATIO);
 const band = Math.max(DROP_BAND_MIN_PX, Math.min(DROP_BAND_MAX_PX, rawBand));
 if (clientY < rect.top + band) return "top";
 if (clientY > rect.top + rect.height - band) return "bottom";
 return "center";
}

/** Classify a drop position within a tree row using tree-specific bands.
 * Tree rows are ~22px tall, so we use much smaller bands [5px, 10px]
 * to make the center (make-child) zone reachable. */
export function classifyTreeDropZone(
 rect: { top: number; height: number },
 clientY: number,
): "top" | "center" | "bottom" {
 const rawBand = Math.floor(rect.height * DROP_BAND_RATIO);
 const band = Math.max(
  TREE_DROP_BAND_MIN_PX,
  Math.min(TREE_DROP_BAND_MAX_PX, rawBand),
 );
 if (clientY < rect.top + band) return "top";
 if (clientY > rect.top + rect.height - band) return "bottom";
 return "center";
}

/** Drop-intent kind tag — single discriminator for the single-ref architecture. */
export type DropIntentKind = "card" | "zone" | "column" | "tree-row";

/** Unified drop intent — one ref replaces 4+ scattered refs/states. */
export interface DropIntent {
 kind: DropIntentKind;
 /** Card target: the hovered card's task id. */
 taskId?: string;
 /** Column target: the hovered column id. */
 colId?: string;
 /** Zone target: the hovered children-zone parent task id. */
 parentId?: string;
 /** Edge position when kind=card and zone≠center. */
 position?: "before" | "after";
 /** Edge zone when kind=card and zone≠center. */
 edgeZone?: "top" | "bottom";
 /** Tree-row target: the hovered child row's task id (kind=tree-row). */
 targetId?: string;
 /** True when the zone intent originated from a tree-row center drop.
  *  Tells the drop handler to use canReparent + onTreeReparent
  *  instead of targetValid + onLinkChild. */
 fromTree?: boolean;
}

/** Classify a drop position against a card's article element (not the
 * outer wrapper, which may contain pill/indicator children that distort
 * the bounding rect).
 *
 * When the make-child pill is visible for this card (`pillVisible`), only a
 * cursor that has left the article's bottom edge — i.e. one that is actually
 * over the pill — is pinned to "center", so dropping on the pill behaves as a
 * center drop. A cursor inside the article is always classified by position:
 * pinning the whole card to center made every dragover after the pill appeared
 * classify as center, which made an edge drop (the only way to reorder
 * relative to a card) unreachable.
 *
 * Returns `{ zone, rect }` where `rect` is the article rect used for
 * classification (for callers that need to compute positions from it). */
export function classifyForDropIntent(
 wrapperEl: HTMLElement,
 clientY: number,
 pillVisible: boolean,
): { zone: "top" | "center" | "bottom"; rect: DOMRect } {
 // Prefer the article element inside the wrapper — the pill/indicator
 // mounts inside the wrapper but outside the article, so the article
 // rect is immune to pill presence.
 const articleEl = wrapperEl.querySelector("article") as HTMLElement | null;
 const rect = articleEl
  ? articleEl.getBoundingClientRect()
  : wrapperEl.getBoundingClientRect();

 if (pillVisible && clientY > rect.bottom) {
  return { zone: "center", rect };
 }
 return { zone: classifyDropZone(rect, clientY), rect };
}

/**
 * Classify a dragover position within a tree child row.
 * Uses tree-specific bands (5–10px) so the center (make-child) zone
 * is reachable on ~22px rows. Top/bottom bands → tree-row before/after
 * (sibling reorder within parentId), center → zone intent with fromTree
 * flag (make-child of that row's task via onTreeReparent).
 *
 * Null-safe: returns null when the row's task has no id.
 */
export function classifyTreeRowIntent(
 rowRect: { top: number; height: number },
 clientY: number,
 child: { id?: string | null } | null | undefined,
 parentId: string,
): DropIntent | null {
 const childId = child?.id;
 if (!childId) return null;
 const zone = classifyTreeDropZone(rowRect, clientY);
 if (zone === "top")
  return {
   kind: "tree-row",
   targetId: childId,
   parentId,
   position: "before",
  };
 if (zone === "bottom")
  return { kind: "tree-row", targetId: childId, parentId, position: "after" };
 return { kind: "zone", parentId: childId, fromTree: true };
}

/**
 * Check whether draggedId may be reparented under targetId.
 * Self/descendant checks only — unlike targetValid this deliberately
 * allows reparenting tasks that already have a parent (the old parent
 * link is replaced, not duplicated).
 */
export function canReparent(
 allTasks: Task[],
 draggedId: string,
 targetId: string,
): boolean {
 if (!draggedId || !targetId) return false;
 if (draggedId === targetId) return false;
 const descendants = getDescendants(allTasks ?? [], draggedId);
 if (descendants.includes(targetId)) return false;
 return true;
}

/**
 * Module-level drag session singleton — shared drag-source state for tree
 * rows without prop-drilling. The board mirrors its card-drag ref here
 * (begin on dragstart, end on drop/dragend); the detail panel reads get()
 * to resolve the dragged id for drops outside the board columns.
 */
let dragSessionId: string | null = null;
export const dragSession = {
 get(): string | null {
  return dragSessionId;
 },
 begin(id: string): void {
  if (!id) return;
  dragSessionId = id;
 },
 end(): void {
  dragSessionId = null;
 },
};

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

/**
 * Whether dropping draggedId on targetId as a child is actionable at all.
 * A parentless task links (`targetValid`); an already-parented task reparents
 * instead — the single-parent rule rejects the link, not the move, so a
 * nested child can still be dragged up to another card or ancestor.
 */
export function canDropAsChild(
 allTasks: Task[],
 draggedId: string,
 targetId: string,
): boolean {
 if (!draggedId || !targetId) return false;
 return (
  targetValid(allTasks, draggedId, targetId) ||
  canReparent(allTasks, draggedId, targetId)
 );
}

/** Key plan for a children-tree sibling reorder / reparent drop. */
export interface TreeReorderPlan {
 /** The dragged task's new sort key — persist it on the dragged task. */
 newSortKey: string;
 /**
  * Re-keyed legacy siblings (no sortKey, or the legacy `'n'`). They MUST be
  * persisted together with `newSortKey`: compareTaskOrder sorts keyless
  * tasks after every keyed task, so the key computed around an unapplied
  * keyless neighbour lands the dragged task before it, not next to it.
  */
 normalizationPatches: ReorderPatch[];
}

/**
 * Resolve the sort key for a sibling reorder inside one parent.
 *
 * Sibling order is the order the tree renders (compareTaskOrder): keyed tasks
 * ascending, keyless tasks after them by timestamp. `targetId`/`position`
 * describe the drop relative to a rendered sibling; the dragged task is
 * excluded from the neighbour search (it is the one moving). A missing/absent
 * target appends last, which is what a zone or children-zone drop means.
 *
 * Returns the dragged key plus the normalization patches the caller must
 * apply alongside it — applying only the key is what made sibling order
 * unreliable for tasks that never carried a sortKey.
 */
export function computeTreeReorder(
 allTasks: Task[],
 draggedId: string,
 parentId: string,
 targetId: string | null,
 position: "before" | "after" = "after",
): TreeReorderPlan | null {
 if (!draggedId || !parentId) return null;
 const siblings = getChildren(allTasks ?? [], parentId)
  .filter((t) => t?.id && t.id !== draggedId)
  .sort(compareTaskOrder);

 let beforeId: string | null = null;
 let afterId: string | null = null;
 const targetIndex = targetId
  ? siblings.findIndex((t) => t.id === targetId)
  : -1;

 if (targetIndex >= 0) {
  if (position === "before") {
   afterId = targetId;
   beforeId = targetIndex > 0 ? siblings[targetIndex - 1].id : null;
  } else {
   beforeId = targetId;
   afterId =
    targetIndex < siblings.length - 1 ? siblings[targetIndex + 1].id : null;
  }
 } else {
  // No target (or target not among the new siblings) → append last.
  beforeId = siblings[siblings.length - 1]?.id ?? null;
 }

 const { newSortKey, normalizationPatches } = computeReorder(
  siblings.map((t) => ({ id: t.id, sortKey: t.sortKey })),
  draggedId,
  beforeId,
  afterId,
  maxSortKey(allTasks ?? []),
  allTasks ?? [],
 );
 return { newSortKey, normalizationPatches };
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
