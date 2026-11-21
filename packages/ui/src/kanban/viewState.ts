import type { ViewMode } from "./types";

export const MOBILE_VIEWPORT_MAX_WIDTH = 767;

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

/**
 * Owner order (2026-11-21, ticket 6e927e14908f0cc28c89106657b0bd): kanban is
 * the ONLY view at every width — list and compact are gone product-wide, so
 * the saved preference and any stale mobile override both resolve to board.
 * A stored `list`/`compact` preference needs no migration: it is read, resolved
 * to board, and never written back (the view toggle that could write one is
 * gone). Signature kept so both hosts still compile unchanged.
 */
export function resolveResponsiveView(
  _savedView: ViewMode,
  _viewportWidth: number,
  _mobileOverride: ViewMode | null = null,
): ViewMode {
  return "board";
}
