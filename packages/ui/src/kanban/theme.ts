/**
 * Shared theme resolver — the single place that knows the kanban theme names,
 * the persistence key, and how to read/apply the preference. Used by every
 * kanban consumer of @vibeflow-tools/ui.
 *
 * Persistence lives in localStorage under THEME_STORAGE_KEY. Every read is
 * validated against THEMES so a stale/garbage value can never produce an
 * unknown data-theme. All helpers are SSR-safe: with no `window`/`document`
 * they degrade to no-ops instead of throwing.
 *
 * The theme LIST lives in theme-registry.ts and is re-exported here; this file
 * only owns persistence + application so the resolver and the registry stay in
 * sync by construction.
 */

import { THEMES, type Theme } from "./theme-registry";

export {
  THEME_REGISTRY,
  THEMES,
  DEFAULT_THEME,
  getThemeDefinition,
} from "./theme-registry";
export type { Theme, ThemeDefinition, ThemeBase } from "./theme-registry";

export const THEME_STORAGE_KEY = "vibeflow.kanban.theme";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : null;
  } catch {
    // Accessing localStorage can throw in privacy modes / sandboxed frames.
    return null;
  }
}

/** Stored theme if it is valid, otherwise null. Never throws, SSR-safe. */
export function getStoredTheme(storage?: Storage | null): Theme | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persist an explicit theme preference. No-op without storage. */
export function setStoredTheme(theme: Theme, storage?: Storage | null): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** Drop the stored preference so the system fallback resumes. */
export function clearStoredTheme(storage?: Storage | null): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(THEME_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Theme to apply on boot, or null when the user has no explicit preference —
 * in that case no `data-theme` is written and the CSS
 * `@media (prefers-color-scheme: light)` fallback takes over.
 */
export function resolveInitialTheme(storage?: Storage | null): Theme | null {
  return getStoredTheme(storage);
}

/** Write/clear `data-theme` on an element (defaults to <html>). SSR-safe. */
export function applyTheme(
  theme: Theme | null,
  target?: HTMLElement | null,
): void {
  const el =
    target ?? (typeof document === "undefined" ? null : document.documentElement);
  if (!el) return;
  if (theme) el.setAttribute("data-theme", theme);
  else el.removeAttribute("data-theme");
}

/** Resolve + apply the persisted theme on boot. SSR-safe no-op. */
export function applyInitialTheme(target?: HTMLElement | null): Theme | null {
  const theme = resolveInitialTheme();
  applyTheme(theme, target);
  return theme;
}
