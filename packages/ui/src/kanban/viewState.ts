import type { ViewMode } from "./types";

export const MOBILE_VIEWPORT_MAX_WIDTH = 767;

/** Resolve the effective view without mutating the user's saved desktop choice. */
export function resolveResponsiveView(
  savedView: ViewMode,
  viewportWidth: number,
  mobileOverride: ViewMode | null = null,
): ViewMode {
  if (viewportWidth <= MOBILE_VIEWPORT_MAX_WIDTH) {
    return mobileOverride ?? "list";
  }
  return savedView;
}
