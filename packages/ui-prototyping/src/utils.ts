/**
 * URL and localStorage helpers for variant persistence.
 *
 * URL format:  ?vf[ScopeName]=variantKey
 * localStorage key prefix: __vf__
 *
 * URL takes precedence over localStorage (shareable links win).
 */

const URL_PARAM_PREFIX = "vf";
const LS_PREFIX = "__vf__";

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Encode a scope name for use as a URL query param key: "vf[ScopeName]" */
export function encodeUrlKey(name: string): string {
  return `${URL_PARAM_PREFIX}[${name}]`;
}

/** Read the active variant for a scope from the current URL search params. */
export function readVariantFromUrl(name: string): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get(encodeUrlKey(name));
}

/** Write the active variant for a scope into the URL (pushState — no reload). */
export function writeVariantToUrl(name: string, variant: string): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  params.set(encodeUrlKey(name), variant);
  const newSearch = params.toString();
  const newUrl = `${window.location.pathname}?${newSearch}${window.location.hash}`;
  window.history.pushState(null, "", newUrl);
}

/** Remove a scope's variant from the URL. */
export function removeVariantFromUrl(name: string): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  params.delete(encodeUrlKey(name));
  const newSearch = params.toString();
  const newUrl =
    newSearch
      ? `${window.location.pathname}?${newSearch}${window.location.hash}`
      : `${window.location.pathname}${window.location.hash}`;
  window.history.pushState(null, "", newUrl);
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function lsKey(name: string): string {
  return `${LS_PREFIX}${name}`;
}

/** Read the active variant for a scope from localStorage. */
export function readVariantFromStorage(name: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(lsKey(name));
  } catch {
    return null;
  }
}

/** Write the active variant for a scope to localStorage. */
export function writeVariantToStorage(name: string, variant: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(lsKey(name), variant);
  } catch {
    // Silently ignore (private browsing, storage quota, etc.)
  }
}

/** Remove a scope's variant from localStorage. */
export function removeVariantFromStorage(name: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(lsKey(name));
  } catch {
    // Silently ignore
  }
}

// ---------------------------------------------------------------------------
// UI visibility persistence
// ---------------------------------------------------------------------------

const UI_VISIBLE_KEY = "__vf__ui_visible__";

/** Persist the UI visibility flag. */
export function writeUiVisibleToStorage(visible: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UI_VISIBLE_KEY, String(visible));
  } catch {
    // Silently ignore
  }
}

/** Read the persisted UI visibility flag. Returns null when not set. */
export function readUiVisibleFromStorage(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const val = window.localStorage.getItem(UI_VISIBLE_KEY);
    if (val === null) return null;
    return val !== "false";
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Combined resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the active variant for a scope.
 * Priority: URL param → localStorage → provided default key.
 */
export function resolveActiveVariant(
  name: string,
  variantKeys: string[],
  defaultKey: string,
): string {
  const fromUrl = readVariantFromUrl(name);
  if (fromUrl && variantKeys.includes(fromUrl)) return fromUrl;

  const fromStorage = readVariantFromStorage(name);
  if (fromStorage && variantKeys.includes(fromStorage)) return fromStorage;

  return defaultKey;
}
