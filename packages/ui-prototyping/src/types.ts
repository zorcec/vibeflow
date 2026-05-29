/**
 * Core TypeScript types for @vibeflow-tools/ui-prototyping.
 *
 * VariantDefinitions maps variant names to arbitrary config objects.
 * The generic V type preserves key-literal types for TypeScript consumers.
 */

/** A map of variant name → arbitrary config object. */
export type VariantDefinitions<
  V extends Record<string, Record<string, unknown>>,
> = V;

/** The mode controls when variant switcher UI is visible. */
export type VariantMode = "dev" | "always";

/** Internal state stored per named scope. */
export interface VariantState {
  /** Currently active variant name. */
  activeVariant: string;
  /** All registered variant names for this scope. */
  variantNames: string[];
}

/** The shape of the context value exposed by VariantProvider. */
export interface VariantContextValue {
  /** Get the active variant name for a given scope. */
  getActiveVariant: (name: string) => string;
  /** Set the active variant for a scope. */
  setActiveVariant: (name: string, variant: string) => void;
  /** Register a scope with its variant names (called by useVariant / VariantSwitcher). */
  registerScope: (name: string, variantNames: string[]) => void;
  /** All registered scopes and their states. */
  scopes: Record<string, VariantState>;
  /** Whether switcher UI should be visible. */
  uiVisible: boolean;
  /** Toggle switcher UI visibility. */
  toggleUiVisible: () => void;
  /** The current mode ("dev" | "always"). */
  mode: VariantMode;
}

/** Props for VariantProvider. */
export interface VariantProviderProps {
  children: React.ReactNode;
  /**
   * "dev" (default) — switcher UI is hidden unless NODE_ENV !== "production".
   * "always" — switcher UI is always visible (useful for A/B testing / user-facing demos).
   */
  mode?: VariantMode;
  /**
   * Initial UI visibility state.
   * Defaults to true when mode allows it.
   */
  defaultVisible?: boolean;
}

/** Props shared by switcher components. */
export interface SwitcherProps {
  /** Scope name — must match the first argument of useVariant. */
  name: string;
  /** Variant definitions object — same as passed to useVariant. */
  variants: Record<string, Record<string, unknown>>;
  /** Preferred side for floating placement. Default: "right". */
  position?: "right" | "left";
}
