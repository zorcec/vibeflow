import type { ViewMode } from "./types";

export const MOBILE_VIEWPORT_MAX_WIDTH = 767;

/** The ONLY view at <=767px (MOBILE-KANBAN M1, ticket k2x2agpos66jpsggi1owj1er).
 * List and compact are removed on phones — the view toggle is hidden there
 * too (kanban.css narrow block) — so no mobile override can select them. */
const MOBILE_VIEW_MODE: ViewMode = "board";

/** Resolve the effective view without mutating the user's saved desktop choice. */
export function resolveMobileOverrideAfterResize(
  previousWidth: number,
  nextWidth: number,
  mobileOverride: ViewMode | null,
): ViewMode | null {
  return previousWidth <= MOBILE_VIEWPORT_MAX_WIDTH &&
    nextWidth > MOBILE_VIEWPORT_MAX_WIDTH
    ? null
    : mobileOverride;
}

export function resolveResponsiveView(
  savedView: ViewMode,
  viewportWidth: number,
  // Underscore-prefixed: kept in the signature because both hosts (hosted
  // app, CLI board) still pass it, but ignored on phones as of MOBILE-KANBAN
  // M1 — a phone can no longer select list/compact at all.
  _mobileOverride: ViewMode | null = null,
): ViewMode {
  if (viewportWidth <= MOBILE_VIEWPORT_MAX_WIDTH) {
    return MOBILE_VIEW_MODE;
  }
  return savedView;
}
