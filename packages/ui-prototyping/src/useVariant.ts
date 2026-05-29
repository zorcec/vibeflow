import { useEffect, useMemo } from "react";
import { useVariantContext } from "./context.js";
import { getRegisteredVariant } from "./registry.js";
import { resolveActiveVariant } from "./utils.js";

/**
 * Core hook for reading the active variant config.
 *
 * Registers the scope with the VariantProvider, resolves the active variant
 * from URL → localStorage → default, and returns the corresponding config.
 *
 * @param name  - Unique scope name (e.g. "TaskCard", "KanbanBoard")
 * @param variants - Variant definitions object; first key is the default
 * @returns The config object for the active variant
 *
 * @example
 * const variants = {
 *   default: {},
 *   minimal: { compact: true },
 *   detailed: { showMeta: true, showComments: true },
 * }
 *
 * function TaskCard() {
 *   const variant = useVariant('TaskCard', variants)
 *   return <div className={variant.compact ? 'compact' : ''}>…</div>
 * }
 */
export function useVariant<
  V extends Record<string, Record<string, unknown>>,
>(
  name: string,
  variants: V,
): V[keyof V] {
  const ctx = useVariantContext();

  // Merge registered variants with inline variants; inline wins.
  const mergedVariants = useMemo(() => {
    const registered = getRegisteredVariant(name);
    return registered ? { ...registered, ...variants } : variants;
  }, [name, variants]);

  const variantKeys = useMemo(
    () => Object.keys(mergedVariants),
    [mergedVariants],
  );

  // Register (or re-register) the scope when variant keys change
  useEffect(() => {
    ctx.registerScope(name, variantKeys);
  }, [ctx, name, variantKeys]);

  // Resolve the active variant (URL → localStorage → first key)
  const activeKey = useMemo(() => {
    const currentActive = ctx.getActiveVariant(name);
    // If context already has a valid selection, use it; otherwise resolve fresh
    if (currentActive && variantKeys.includes(currentActive)) {
      return currentActive;
    }
    return resolveActiveVariant(name, variantKeys, variantKeys[0] ?? "default");
  }, [ctx, name, variantKeys]);

  return (mergedVariants[activeKey] ?? mergedVariants[variantKeys[0] ?? "default"] ?? {}) as V[keyof V];
}
