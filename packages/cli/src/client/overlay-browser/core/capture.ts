/**
 * Baseline + auth capture — automatic at annotation time.
 *
 * Runs in the browser (not Node.js). Uses standard DOM APIs.
 * No verify mode, no navigation lock, no visual indicator.
 * Baseline and auth state are captured automatically when the user annotates an element.
 */

import type { DomSnapshot, ProtoConfig, PageSnapshot } from "./types.js";
import { captureAuthState } from "./auth.js";
import { surfacePath } from "../../../core/api-url.js";

declare const PROTO_CONFIG: ProtoConfig;

/**
 * Mode discriminator for the overlay bundle. The SaaS-injected config
 * (`getOverlaySaasScript`) points `apiUrl` at `<cloud>/api/overlay/tasks`
 * and carries a boardId; the locally-injected config (`getOverlayScript`)
 * points at `<origin>/api/tasks`. `surfacePath` never guesses, so every
 * capture call below derives the mode from this and passes it explicitly.
 */
function isCloudTarget(apiUrl: string | undefined): boolean {
  return apiUrl?.includes("/api/overlay/tasks") ?? false;
}

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
    // Use PROTO_CONFIG global set by the overlay injection script (same as api.ts).
    const cfg = PROTO_CONFIG;

    // Construct the baseline API URL from the base API URL
    // Cloud targets serve the v1 contract; local targets keep the legacy path.
    const baselinePath = surfacePath(
      isCloudTarget(cfg?.apiUrl) ? "cloud" : "local",
      `/api/tasks/${taskId}/baseline`,
    );
    let apiUrl = baselinePath;
    if (cfg?.apiUrl) {
      // Extract the base URL (origin + port) from the API URL
      const baseUrl = cfg.apiUrl.replace(/\/api\/(overlay\/)?tasks$/, "");
      apiUrl = `${baseUrl}${baselinePath}`;
    }
    if (cfg?.boardId) {
      apiUrl += `?boardId=${encodeURIComponent(cfg.boardId)}`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cfg?.overlayApiKey) {
      headers["X-Overlay-Api-Key"] = cfg.overlayApiKey;
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
export async function sendPageBaselineToServer(
  taskId: string,
  page: PageSnapshot,
): Promise<void> {
  try {
    const cfg = PROTO_CONFIG;

    // Cloud targets serve the v1 contract; local targets keep the legacy path.
    const pagePath = surfacePath(
      isCloudTarget(cfg?.apiUrl) ? "cloud" : "local",
      `/api/tasks/${taskId}/baseline-page`,
    );
    let apiUrl = pagePath;
    if (cfg?.apiUrl) {
      const baseUrl = cfg.apiUrl.replace(/\/api\/(overlay\/)?tasks$/, "");
      apiUrl = `${baseUrl}${pagePath}`;
    }
    if (cfg?.boardId) {
      apiUrl += `?boardId=${encodeURIComponent(cfg.boardId)}`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cfg?.overlayApiKey) {
      headers["X-Overlay-Api-Key"] = cfg.overlayApiKey;
    }

    await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ page }),
    });
  } catch (err) {
    console.error("[Vibeflow] Failed to store page baseline:", err);
  }
}

export async function captureAndStoreAuthState(
  taskId: string,
  taskAuthor: string,
): Promise<void> {
  const authState = captureAuthState();

  try {
    // Use PROTO_CONFIG global set by the overlay injection script (same as api.ts).
    const cfg = PROTO_CONFIG;

    // Construct the auth-state API URL from the base API URL
    // Cloud targets serve the v1 contract (cloud answers 501 LOCAL_ONLY for
    // auth-state per the contract); local targets keep the legacy path.
    const authPath = surfacePath(
      isCloudTarget(cfg?.apiUrl) ? "cloud" : "local",
      `/api/tasks/${taskId}/auth-state`,
    );
    let apiUrl = authPath;
    if (cfg?.apiUrl) {
      // Extract the base URL (origin + port) from the API URL
      const baseUrl = cfg.apiUrl.replace(/\/api\/(overlay\/)?tasks$/, "");
      apiUrl = `${baseUrl}${authPath}`;
    }
    if (cfg?.boardId) {
      apiUrl += `?boardId=${encodeURIComponent(cfg.boardId)}`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cfg?.overlayApiKey) {
      headers["X-Overlay-Api-Key"] = cfg.overlayApiKey;
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
