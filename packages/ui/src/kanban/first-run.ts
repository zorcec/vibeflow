/**
 * First-run onboarding (ticket eajggnmjdyq226kzfn7yk3mw).
 *
 * A fresh board (no tasks yet) opens the settings modal automatically so
 * the owner sees the review-gate defaults (verification verdict + comment
 * on review) before doing anything else. The flag is written on the FIRST
 * auto-open, so later visits — empty or not — never re-open it. A user can
 * still open settings by hand at any time.
 *
 * DOM-free by design (the key + the decision live here, storage is
 * injected) so unit tests pin the matrix without a browser.
 */

/** localStorage key marking the first-run settings tour as done. */
export const KANBAN_ONBOARDED_KEY = "vibeflow.kanban.onboarded";

/** Minimal storage surface — real localStorage satisfies it directly. */
export interface OnboardedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FirstRunState {
  /** True while the initial board read is still in flight. */
  isLoading: boolean;
  /** Number of tasks on the board (root list length is enough). */
  taskCount: number;
  /** True when settings is already open (never fight the user). */
  settingsOpen: boolean;
}

/**
 * True exactly when the board should auto-open settings: the initial load
 * finished, the board is empty, settings is not already open, and no
 * previous visit recorded the onboarding flag. All other shapes (flag set,
 * tasks present, still loading, already open) stay closed.
 */
export function shouldAutoOpenSettings(
  storage: OnboardedStorage | null | undefined,
  state: FirstRunState,
): boolean {
  if (state.isLoading) return false;
  if (state.settingsOpen) return false;
  if (state.taskCount > 0) return false;
  try {
    if (storage?.getItem(KANBAN_ONBOARDED_KEY) != null) return false;
  } catch {
    // Storage unavailable (private mode) — treat as not-onboarded so the
    // first-run tour still shows; the mark below best-efforts the write.
  }
  return true;
}

/** Record the onboarding as done (best-effort — never throws). */
export function markOnboarded(
  storage: OnboardedStorage | null | undefined,
): void {
  try {
    storage?.setItem(KANBAN_ONBOARDED_KEY, "1");
  } catch {
    /* private-mode writes throw — the tour simply shows once per session */
  }
}
