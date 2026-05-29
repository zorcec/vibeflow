import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type {
  VariantContextValue,
  VariantState,
  VariantMode,
  VariantProviderProps,
} from "./types.js";
import {
  resolveActiveVariant,
  writeVariantToUrl,
  writeVariantToStorage,
  writeUiVisibleToStorage,
  readUiVisibleFromStorage,
} from "./utils.js";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const VariantContext = createContext<VariantContextValue | null>(null);

/** Access the variant context. Throws if used outside VariantProvider. */
export function useVariantContext(): VariantContextValue {
  const ctx = useContext(VariantContext);
  if (!ctx) {
    throw new Error("useVariantContext must be used inside <VariantProvider>");
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Determine initial UI visibility based on mode and persisted state. */
function resolveInitialUiVisible(
  mode: VariantMode,
  defaultVisible: boolean | undefined,
): boolean {
  // "always" mode: respect defaultVisible, fallback to true
  if (mode === "always") {
    return defaultVisible ?? true;
  }
  // "dev" mode: check localStorage first, then defaultVisible, then true
  // (dev defaults to visible so devs see switchers immediately)
  const persisted = readUiVisibleFromStorage();
  if (persisted !== null) return persisted;
  return defaultVisible ?? true;
}

/**
 * VariantProvider wraps your app (or a subtree) and provides the variant
 * switching system. All useVariant hooks and switcher components below it
 * share state via this provider.
 *
 * @example
 * <VariantProvider>
 *   <App />
 * </VariantProvider>
 *
 * @example
 * // Always visible — for A/B testing or user-facing demos
 * <VariantProvider mode="always">
 *   <App />
 * </VariantProvider>
 */
export function VariantProvider({
  children,
  mode = "dev",
  defaultVisible,
}: VariantProviderProps): ReactNode {
  const [scopes, setScopes] = useState<Record<string, VariantState>>({});
  const [uiVisible, setUiVisible] = useState<boolean>(() =>
    resolveInitialUiVisible(mode, defaultVisible),
  );

  // Track which scopes already have a VariantSwitcher rendered (dedup per scope)
  const registeredSwitchers = useRef(new Set<string>());

  const registerScope = useCallback(
    (name: string, variantNames: string[]) => {
      setScopes((prev) => {
        // Avoid unnecessary re-renders if scope already registered with same names
        const existing = prev[name];
        if (
          existing &&
          existing.variantNames.length === variantNames.length &&
          existing.variantNames.every((v, i) => v === variantNames[i])
        ) {
          return prev;
        }
        const firstKey = variantNames[0] ?? "default";
        const activeVariant = resolveActiveVariant(
          name,
          variantNames,
          existing?.activeVariant ?? firstKey,
        );
        return { ...prev, [name]: { activeVariant, variantNames } };
      });
    },
    [],
  );

  const getActiveVariant = useCallback(
    (name: string): string => {
      return scopes[name]?.activeVariant ?? "";
    },
    [scopes],
  );

  const setActiveVariant = useCallback(
    (name: string, variant: string) => {
      setScopes((prev) => {
        const existing = prev[name];
        if (!existing) return prev;
        if (existing.activeVariant === variant) return prev;
        return { ...prev, [name]: { ...existing, activeVariant: variant } };
      });
      writeVariantToUrl(name, variant);
      writeVariantToStorage(name, variant);
    },
    [],
  );

  const toggleUiVisible = useCallback(() => {
    setUiVisible((prev) => {
      const next = !prev;
      writeUiVisibleToStorage(next);
      return next;
    });
  }, []);

  // Switcher dedup: register returns true if this is the first instance for the scope
  const registerSwitcher = useCallback((name: string): boolean => {
    if (registeredSwitchers.current.has(name)) return false;
    registeredSwitchers.current.add(name);
    return true;
  }, []);

  const unregisterSwitcher = useCallback((name: string): void => {
    registeredSwitchers.current.delete(name);
  }, []);

  // Keyboard shortcuts: Alt+H toggles UI, Ctrl+Shift+V also toggles
  useKeyboardShortcuts({
    onToggleUi: toggleUiVisible,
  });

  const value: VariantContextValue = {
    getActiveVariant,
    setActiveVariant,
    registerScope,
    registerSwitcher,
    unregisterSwitcher,
    scopes,
    uiVisible,
    toggleUiVisible,
    mode,
  };

  return (
    <VariantContext.Provider value={value}>
      {children}
    </VariantContext.Provider>
  );
}
