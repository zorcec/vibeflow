/**
 * Baseline + auth capture — automatic at annotation time.
 *
 * Runs in the browser (not Node.js). Uses standard DOM APIs.
 * No verify mode, no navigation lock, no visual indicator.
 * Baseline and auth state are captured automatically when the user annotates an element.
 */

import type { DomSnapshot } from "./types.js";
import { captureAuthState } from "./auth.js";
import { state } from "../state.js";

// ── Send baseline to CLI server ──────────────────────────────────────────────

/**
 * Send baseline snapshot to CLI server for storage (spec §6).
 * Called automatically at annotation time.
 *
 * @param taskId - The task ID
 * @param baseline - The captured DOM snapshot
 */
export async function sendBaselineToServer(
  taskId: string,
  baseline: DomSnapshot,
): Promise<void> {
  try {
    // SAFETY: __PROTO_CONFIG is injected at runtime by the CLI server as a global variable.
    const rawConfig = (window as unknown as Record<string, unknown>)
      .__PROTO_CONFIG as unknown;
    // SAFETY: narrows to the known PROTO_CONFIG shape used throughout the overlay (see api.ts).
    const protoConfig = rawConfig as
      | { boardId?: string; apiUrl?: string; overlayApiKey?: string }
      | undefined;

    // Construct the baseline API URL from the base API URL
    let apiUrl = `/api/tasks/${taskId}/baseline`;
    if (protoConfig?.apiUrl) {
      // Extract the base URL (origin + port) from the API URL
      const baseUrl = protoConfig.apiUrl.replace(/\/api\/(overlay\/)?tasks$/, "");
      apiUrl = `${baseUrl}/api/tasks/${taskId}/baseline`;
    }
    if (protoConfig?.boardId) {
      apiUrl += `?boardId=${encodeURIComponent(protoConfig.boardId)}`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (protoConfig?.overlayApiKey) {
      headers["X-Overlay-Api-Key"] = protoConfig.overlayApiKey;
    }

    await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseline }),
    });
  } catch (err) {
    // Baseline storage is best-effort — don't break the overlay
    console.error("[Vibeflow] Failed to store baseline:", err);
  }
}

// ── Capture auth state and send to CLI server ────────────────────────────────

/**
 * Capture auth state and send to CLI server for encryption + storage.
 * The CLI server handles the actual crypto (Node.js) and disk write.
 * Called automatically at annotation time.
 *
 * @param taskId - The task ID
 * @param taskAuthor - The task author (for encryption key derivation)
 */
export async function captureAndStoreAuthState(
  taskId: string,
  taskAuthor: string,
): Promise<void> {
  const authState = captureAuthState();

  try {
    // SAFETY: __PROTO_CONFIG is a global set by the overlay injection script — same pattern as api.ts
    const protoConfig = (window as unknown as Record<string, unknown>)
      .__PROTO_CONFIG as
      | { boardId?: string; apiUrl?: string; overlayApiKey?: string }
      | undefined;

    // Construct the auth-state API URL from the base API URL
    let apiUrl = `/api/tasks/${taskId}/auth-state`;
    if (protoConfig?.apiUrl) {
      // Extract the base URL (origin + port) from the API URL
      const baseUrl = protoConfig.apiUrl.replace(/\/api\/(overlay\/)?tasks$/, "");
      apiUrl = `${baseUrl}/api/tasks/${taskId}/auth-state`;
    }
    if (protoConfig?.boardId) {
      apiUrl += `?boardId=${encodeURIComponent(protoConfig.boardId)}`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (protoConfig?.overlayApiKey) {
      headers["X-Overlay-Api-Key"] = protoConfig.overlayApiKey;
    }

    await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        authState,
        taskAuthor,
      }),
    });
  } catch (err) {
    // Auth state storage is best-effort — don't break the overlay
    console.error("[Vibeflow] Failed to store auth state:", err);
  }
}
