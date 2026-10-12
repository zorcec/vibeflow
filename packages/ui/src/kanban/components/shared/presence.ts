import type { PresenceArea } from "../../types";

/**
 * User-facing label for a presence area (vibeflow task 652e9450).
 *
 * The activity feed tab reads "Activity" and the pane is the activity feed,
 * so presence copy must agree with it: "Ana is in activity", never
 * "Ana is in comments". Internal identifiers stay untouched — tab keys,
 * the `PresenceArea` wire values, `data-testid`s and the comment data
 * model all keep the raw area ("comments"); only strings a user reads go
 * through this mapping.
 *
 * Singular "activity" (not "activities") to match the existing tab label
 * and the pane's "No activity yet." empty state.
 */
export function presenceAreaLabel(area: PresenceArea): string {
  return area === "comments" ? "activity" : area;
}

/**
 * Compact initials for a presence avatar chip (vibeflow task bc908cca).
 *
 * "Tomislav Zorčec" → "TZ", "Ana" → "AN". Unicode-aware (Array.from)
 * so astral-plane names never split a surrogate pair.
 */
export function presenceInitials(user: string): string {
  const parts = user.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const chars = (s: string): string[] => Array.from(s);
  if (parts.length === 1) {
    const letters = chars(parts[0]!);
    return ((letters[0] ?? "?") + (letters[1] ?? "")).toUpperCase();
  }
  const first = chars(parts[0]!)[0] ?? "?";
  const last = chars(parts[parts.length - 1]!)[0] ?? "";
  return (first + last).toUpperCase();
}

/**
 * Stable per-peer colour for presence avatar chips (vibeflow task bc908cca).
 *
 * Mirrors shared `userColor` (same 12-hue palette, same string hash) so a
 * peer's chip matches their description-cursor colour — the same person is
 * the same colour everywhere. Duplicated (not imported) because the kanban
 * UI never imports the wire-contract package for rendering.
 */
const PRESENCE_HUES = [
  0, 30, 55, 95, 140, 175, 200, 220, 250, 280, 310, 330,
] as const;

export function presenceColor(userId: string | undefined): string {
  if (!userId) return "hsl(220, 9%, 55%)";
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue =
    PRESENCE_HUES[
      ((hash % PRESENCE_HUES.length) + PRESENCE_HUES.length) %
        PRESENCE_HUES.length
    ]!;
  return `hsl(${hue}, 70%, 55%)`;
}
