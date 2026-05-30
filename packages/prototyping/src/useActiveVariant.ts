import { useMemo } from "react";
import { useVariantContext } from "./context.js";
import { resolveActiveVariant } from "./utils.js";

/**
 * Resolves the active variant key for a scope.
 *
 * Checks context first, then falls back to URL → localStorage → default.
 * Used by useVariant, VariantSwitcher, and PageVariantSwitcher to avoid
 * duplicating the same resolution logic.
 */
export function useActiveVariant(
  name: string,
  variantKeys: string[],
): string {
  const ctx = useVariantContext();

  return useMemo(() => {
    const current = ctx.getActiveVariant(name);
    if (current && variantKeys.includes(current)) return current;
    return resolveActiveVariant(
      name,
      variantKeys,
      variantKeys[0] ?? "default",
    );
  }, [ctx, name, variantKeys]);
}
