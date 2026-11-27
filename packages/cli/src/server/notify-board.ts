/**
 * ONE place that turns a confirmed BOARD effect into a notification event
 * (tickets mzxp8u98, hb41uxx).
 *
 * The board has two write surfaces — the REST routes and the tRPC router — and
 * they must describe the same write the same way. The REST path already did;
 * the tRPC path broadcast `tasks-updated` over the WebSocket and stopped
 * there, so a task changed from the kanban through tRPC never reached a
 * watching agent (a follower can only learn about writes that become events).
 *
 * `actor: "board"` is the same actor the REST routes use. Activity and payload
 * types stay in `core/notifications.ts` — the projection, the noise filter and
 * the vocabulary live THERE, so this module can never become a second
 * description of what a write means.
 */
import {
  appendConfirmedNotification,
  type NotificationExtras,
} from "../core/notifications.js";
import type {
  HookActivity,
  HookConfirmedPayloads,
} from "../core/hooks/activities.js";

export function notifyBoardEffect<A extends HookActivity>(
  projectDir: string,
  activity: A,
  payload: HookConfirmedPayloads[A],
): void {
  const extras: NotificationExtras = { actor: "board" };
  appendConfirmedNotification(projectDir, { activity, payload }, extras);
}
