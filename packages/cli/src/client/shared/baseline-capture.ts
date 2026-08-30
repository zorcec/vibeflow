/**
 * Shared baseline capture — works in both CLI kanban and overlay contexts.
 *
 * This module provides a unified interface for capturing DOM snapshots
 * and sending them to the server. It works without PROTO_CONFIG by
 * using relative URLs (same-origin).
 */

import { captureDomSnapshot } from "../overlay-browser/core/baseline.js";
import type { DomSnapshot } from "../overlay-browser/core/types.js";

/**
 * Capture a DOM snapshot and send it to the server for storage.
 *
 * This function is fire-and-forget — it logs errors to console but
 * never throws, so it won't break the calling flow.
 *
 * @param taskId - The task ID to associate with the baseline
 * @param selector - CSS selector for the element to snapshot
 */
export async function captureAndStoreBaseline(
   taskId: string,
   selector: string,
): Promise<void> {
   // Skip baseline capture for invalid or placeholder selectors
   if (
      !selector ||
      selector === "/" ||
      selector === "body" ||
      selector === "html"
   ) {
      return;
   }
   try {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) {
         console.warn(
            `[Vibeflow] Cannot capture baseline: element not found for selector "${selector}"`,
         );
         return;
      }

      const snapshot: DomSnapshot = captureDomSnapshot(el, selector);

      // Use relative URL — works in both CLI kanban (same origin) and overlay contexts
      const apiUrl = `/api/tasks/${taskId}/baseline`;

      await fetch(apiUrl, {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ baseline: snapshot }),
      });
   } catch (err) {
      // Baseline storage is best-effort — don't break the calling flow
      console.error("[Vibeflow] Failed to store baseline:", err);
   }
}
