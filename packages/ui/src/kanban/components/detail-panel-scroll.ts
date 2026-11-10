/**
 * Scroll-to-children intent for the detail panel.
 *
 * The board's children popover truncates at CHILD_POPOVER_MAX_VISIBLE rows and
 * ends in a "+N more" affordance. Activating it opens the task through the
 * existing open path (`onOpenTask(parent, "details")`) and records the intent
 * here so the freshly opened panel lands on the full children list at the
 * bottom of the details pane (the relations section has no cap).
 *
 * Two arrivals, one intent:
 * - pending flag — the panel is closed and mounts on open; the DetailPanel
 *   open effect consumes it. A sync event at click time would be missed
 *   because the panel is not mounted yet.
 * - CustomEvent — the panel is already open on the same task, so the open
 *   effect will not rerun for the same task id; the panel scrolls now.
 *
 * Single spelling for the event name lives here with the flag so the popover
 * and the panel cannot drift apart.
 */

/** DOM event the popover dispatches alongside the open call. */
export const SCROLL_RELATIONS_EVENT = "vibeflow:scroll-relations";

let pendingTaskId: string | null = null;

/** Record that the next open of `taskId` should land on its children list. */
export function requestRelationsScroll(taskId: string): void {
  pendingTaskId = taskId;
}

/**
 * Consume the pending intent for `taskId`. Returns true exactly once per
 * request — a stale request for another task is left for its own open.
 */
export function consumeRelationsScroll(taskId: string): boolean {
  if (pendingTaskId === null || pendingTaskId !== taskId) return false;
  pendingTaskId = null;
  return true;
}

/** Build the event the popover dispatches next to the open call. */
export function relationsScrollEvent(taskId: string): CustomEvent<{
  taskId: string;
}> {
  return new CustomEvent(SCROLL_RELATIONS_EVENT, { detail: { taskId } });
}
