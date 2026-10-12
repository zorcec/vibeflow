/**
 * Overlay embed contract — one module so the next rename is one line.
 *
 * Snippets we EMIT use the `OVERLAY_*` names only. Snippets already pasted
 * into customer pages may still carry the `LEGACY_*` names, so every
 * detection path must accept both: prefer the new form, fall back to legacy.
 * (Server + browser bundle both import this; keep it dependency-free.)
 */

/** `<script … data-vibeflow-overlay>` — the attribute new snippets carry. */
export const OVERLAY_SCRIPT_ATTR = "data-vibeflow-overlay";
/** Attribute emitted by older snippets, still live in customer pages. */
export const LEGACY_OVERLAY_SCRIPT_ATTR = "data-proto-overlay";

/** Shadow host id created by current overlay bundles. */
export const OVERLAY_ROOT_ID = "vibeflow-studio-root";
/** Shadow host id created by older bundles, still live in customer pages. */
export const LEGACY_OVERLAY_ROOT_ID = "proto-studio-root";

/** `window` global new console/bookmarklet snippets use for the board id. */
export const BOARD_ID_GLOBAL = "__VIBEFLOW_BOARD_ID";
/** `window` global older snippets set; still read so they keep working. */
export const LEGACY_BOARD_ID_GLOBAL = "__PROTO_BOARD_ID";

/**
 * Finds this overlay's `<script>` tag: the one carrying a board id wins
 * (a page may host several), then the overlay marker attribute (new, then
 * legacy), then the bundle filename. Order is load-bearing — see the
 * data-board-id preference regression test.
 */
export function findOverlayScript(doc: Document): HTMLScriptElement | null {
  return (
    (doc.querySelector("script[data-board-id]") as HTMLScriptElement | null) ??
    (doc.querySelector(
      `script[${OVERLAY_SCRIPT_ATTR}]`,
    ) as HTMLScriptElement | null) ??
    (doc.querySelector(
      `script[${LEGACY_OVERLAY_SCRIPT_ATTR}]`,
    ) as HTMLScriptElement | null) ??
    (doc.querySelector(
      'script[src*="vibeflow-overlay"]',
    ) as HTMLScriptElement | null)
  );
}

/** True when the overlay is already active on the page (either root id). */
export function isOverlayActive(doc: Document): boolean {
  return (
    doc.getElementById(OVERLAY_ROOT_ID) != null ||
    doc.getElementById(LEGACY_OVERLAY_ROOT_ID) != null
  );
}

/** Board id from a CSP-safe global (new snippets first, legacy accepted). */
export function readBoardIdGlobal(
  win: Record<string, unknown>,
): string | undefined {
  const fresh = win[BOARD_ID_GLOBAL];
  if (typeof fresh === "string" && fresh) return fresh;
  const legacy = win[LEGACY_BOARD_ID_GLOBAL];
  return typeof legacy === "string" && legacy ? legacy : undefined;
}
