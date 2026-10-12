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
