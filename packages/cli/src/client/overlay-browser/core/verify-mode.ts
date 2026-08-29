/**
 * Verify mode — activation, navigation lock, visual indicator (spec §8).
 *
 * Runs in the browser (not Node.js).
 */

import { state } from "../state.js";
import { el } from "./dom.js";
import type { DomSnapshot } from "./types.js";
import { captureAuthState } from "./auth.js";
import { getRecordedLogs } from "../error-recorder.js";

// ── Verify mode state ─────────────────────────────────────────────────────────

export interface VerifyModeState {
  active: boolean;
  taskId: string | null;
  taskTitle: string | null;
  taskAuthor: string | null;
  indicator: HTMLElement | null;
  beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null;
  pushStateOrig: typeof history.pushState | null;
  replaceStateOrig: typeof history.replaceState | null;
}

const verifyState: VerifyModeState = {
  active: false,
  taskId: null,
  taskTitle: null,
  taskAuthor: null,
  indicator: null,
  beforeUnloadHandler: null,
  pushStateOrig: null,
  replaceStateOrig: null,
};

// ── Exported getters ──────────────────────────────────────────────────────────

/** Check if verify mode is currently active. */
export function isVerifyModeActive(): boolean {
  return verifyState.active;
}

/** Get the active task ID if verify mode is on. */
export function getVerifyModeTaskId(): string | null {
  return verifyState.taskId;
}

// ── Navigation lock (spec §8.2) ───────────────────────────────────────────────

function installNavigationLock(): void {
  // Hard navigation (tab close, URL bar, refresh)
  verifyState.beforeUnloadHandler = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    // eslint-disable-next-line no-return-assign
    (e as BeforeUnloadEvent & { returnValue: string }).returnValue =
      "Verify mode is active. Leaving will deactivate verification.";
  };
  window.addEventListener("beforeunload", verifyState.beforeUnloadHandler);

  // SPA navigation (React Router, Next.js, etc.)
  verifyState.pushStateOrig = history.pushState.bind(history);
  verifyState.replaceStateOrig = history.replaceState.bind(history);

  history.pushState = (...args: Parameters<typeof history.pushState>) => {
    if (verifyState.active) {
      const confirmed = window.confirm(
        "Verify mode is active. Navigate away and deactivate verification?",
      );
      if (!confirmed) return;
      deactivateVerifyMode();
    }
    verifyState.pushStateOrig?.(...args);
  };

  history.replaceState = (...args: Parameters<typeof history.replaceState>) => {
    if (verifyState.active) {
      const confirmed = window.confirm(
        "Verify mode is active. Navigate away and deactivate verification?",
      );
      if (!confirmed) return;
      deactivateVerifyMode();
    }
    verifyState.replaceStateOrig?.(...args);
  };

  window.addEventListener("popstate", () => {
    if (verifyState.active) {
      deactivateVerifyMode();
    }
  });
}

function uninstallNavigationLock(): void {
  if (verifyState.beforeUnloadHandler) {
    window.removeEventListener("beforeunload", verifyState.beforeUnloadHandler);
    verifyState.beforeUnloadHandler = null;
  }
  if (verifyState.pushStateOrig) {
    history.pushState = verifyState.pushStateOrig;
    verifyState.pushStateOrig = null;
  }
  if (verifyState.replaceStateOrig) {
    history.replaceState = verifyState.replaceStateOrig;
    verifyState.replaceStateOrig = null;
  }
}

// ── Visual indicator (spec §8.3) ──────────────────────────────────────────────

function createIndicator(taskTitle: string): HTMLElement {
  const indicator = el("div", { className: "vibeflow-verify-indicator" });
  indicator.style.cssText = `
    position: fixed;
    bottom: 16px;
    right: 16px;
    background: #065f46;
    color: #d1fae5;
    padding: 12px 16px;
    border-radius: 8px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    z-index: 2147483647;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 280px;
  `;

  const header = el("div", null,
    el("span", null, "🟢 "),
    el("strong", null, "Verify mode active"),
  );

  const taskLabel = el("div", { style: "opacity: 0.8; font-size: 12px;" },
    `Task: ${taskTitle}`,
  );

  const deactivateBtn = el("button", { style: `
    background: rgba(255,255,255,0.15);
    color: #d1fae5;
    border: 1px solid rgba(255,255,255,0.3);
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    align-self: flex-start;
  ` }, "Deactivate");

  deactivateBtn.addEventListener("click", () => {
    deactivateVerifyMode();
  });

  indicator.append(header, taskLabel, deactivateBtn);
  return indicator;
}

function showIndicator(taskTitle: string): void {
  removeIndicator();
  if (!state.root) return;

  const indicator = createIndicator(taskTitle);
  verifyState.indicator = indicator;
  state.root.appendChild(indicator);
}

function removeIndicator(): void {
  if (verifyState.indicator) {
    verifyState.indicator.remove();
    verifyState.indicator = null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Activate verify mode for a task (spec §8.1).
 *
 * Captures auth state, installs navigation lock, and shows visual indicator.
 * The baseline snapshot should already be captured separately at annotation time.
 *
 * @param taskId - The task ID
 * @param taskTitle - The task title (for display)
 * @param taskAuthor - The task author (for encryption key)
 */
export function activateVerifyMode(
  taskId: string,
  taskTitle: string,
  taskAuthor: string,
): void {
  if (verifyState.active) return; // Already active

  verifyState.active = true;
  verifyState.taskId = taskId;
  verifyState.taskTitle = taskTitle;
  verifyState.taskAuthor = taskAuthor;

  // Install navigation lock
  installNavigationLock();

  // Show visual indicator
  showIndicator(taskTitle);

  // The actual auth capture + encryption + API call is handled by the
  // integration layer (modal.ts) which calls this after sending baseline.
  // Here we just capture the auth state for later use.
  void captureAndStoreAuthState(taskId, taskAuthor);
}

/**
 * Deactivate verify mode (spec §8.4).
 */
export function deactivateVerifyMode(): void {
  if (!verifyState.active) return;

  // Uninstall navigation lock
  uninstallNavigationLock();

  // Remove visual indicator
  removeIndicator();

  // Clear state
  verifyState.active = false;
  verifyState.taskId = null;
  verifyState.taskTitle = null;
  verifyState.taskAuthor = null;
}

// ── Auth capture + API call ───────────────────────────────────────────────────

/**
 * Capture auth state and send to CLI server for encryption + storage.
 * The CLI server handles the actual crypto (Node.js) and disk write.
 */
async function captureAndStoreAuthState(taskId: string, taskAuthor: string): Promise<void> {
  const authState = captureAuthState();

  try {
    const url = state.root
      ? `/api/tasks/${taskId}/auth-state`
      : `/api/tasks/${taskId}/auth-state`;

    // Use the same API pattern as other overlay mutations
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Get boardId from PROTO_CONFIG if available
    // SAFETY: PROTO_CONFIG is a global set by the overlay injection script — same pattern as api.ts
    const protoConfig = (window as unknown as Record<string, unknown>).__PROTO_CONFIG as
      { boardId?: string; apiUrl?: string; overlayApiKey?: string } | undefined;

    let apiUrl = `/api/tasks/${taskId}/auth-state`;
    if (protoConfig?.apiUrl) {
      apiUrl = protoConfig.apiUrl.replace(/\/api\/tasks$/, `/api/tasks/${taskId}/auth-state`);
    }
    if (protoConfig?.boardId) {
      apiUrl += `?boardId=${encodeURIComponent(protoConfig.boardId)}`;
    }
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

/**
 * Send baseline snapshot to CLI server for storage (spec §6).
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
    const rawConfig = (window as unknown as Record<string, unknown>).__PROTO_CONFIG as unknown;
    // SAFETY: narrows to the known PROTO_CONFIG shape used throughout the overlay (see api.ts).
    const protoConfig = rawConfig as
      { boardId?: string; apiUrl?: string; overlayApiKey?: string } | undefined;

    let apiUrl = `/api/tasks/${taskId}/baseline`;
    if (protoConfig?.apiUrl) {
      apiUrl = protoConfig.apiUrl.replace(/\/api\/tasks$/, `/api/tasks/${taskId}/baseline`);
    }
    if (protoConfig?.boardId) {
      apiUrl += `?boardId=${encodeURIComponent(protoConfig.boardId)}`;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (protoConfig?.overlayApiKey) {
      headers["X-Overlay-Api-Key"] = protoConfig.overlayApiKey;
    }

    await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseline }),
    });
  } catch (err) {
    // Baseline storage is best-effort
    console.error("[Vibeflow] Failed to store baseline:", err);
  }
}
