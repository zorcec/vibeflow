import { createId } from "@paralleldrive/cuid2";

export function generateId(): string {
  return createId();
}

/**
 * Stable per-user colour for presence and remote cursors.
 *
 * The hue is quantized to a fixed 12-entry palette (neighbours ≥20° apart
 * at 70%/55%) instead of a continuous hash hue: two users must never land
 * on near-identical colours, or their cursors are indistinguishable. The
 * mapping is a pure function of `userId`, so the colour is stable across
 * sessions, replicas and the server/client boundary (the ws presence roster
 * and the doc cursor binding both call this). Format stays
 * `hsl(<int>, 70%, 55%)`.
 */
const USER_COLOR_HUES = [
  0, 30, 55, 95, 140, 175, 200, 220, 250, 280, 310, 330,
] as const;

export function userColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue =
    USER_COLOR_HUES[((hash % USER_COLOR_HUES.length) + USER_COLOR_HUES.length) % USER_COLOR_HUES.length]!;
  return `hsl(${hue}, 70%, 55%)`;
}

export function buildRoomKey(
  workspaceId: string,
  projectId: string,
  boardId: string,
): string {
  return `workspace:${workspaceId}:project:${projectId}:board:${boardId}`;
}

export function parseRoomKey(
  roomKey: string,
): { workspaceId: string; projectId: string; boardId: string } | null {
  const parts = roomKey.split(":");
  if (parts.length !== 6) return null;
  if (parts[0] !== "workspace" || parts[2] !== "project" || parts[4] !== "board")
    return null;
  return {
    workspaceId: parts[1]!,
    projectId: parts[3]!,
    boardId: parts[5]!,
  };
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}
