import { createId } from "@paralleldrive/cuid2";

export function generateId(): string {
  return createId();
}

export function userColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
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
