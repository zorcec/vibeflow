/**
 * Global variant registry.
 *
 * Optional module-level registration of variant definitions so they don't
 * have to be re-passed to every useVariant call in deeply nested trees.
 * Registered variants are merged with inline variant definitions — inline
 * always wins.
 */

type VariantDefs = Record<string, Record<string, unknown>>;

const registry = new Map<string, VariantDefs>();

/**
 * Register a variant definition at module level.
 * Useful when you want to centralise all variant registrations in one file.
 *
 * @example
 * registerVariant('TaskCard', {
 *   default: {},
 *   minimal: { compact: true },
 *   detailed: { showMeta: true },
 * })
 */
export function registerVariant(name: string, variants: VariantDefs): void {
  registry.set(name, variants);
}

/**
 * Retrieve previously registered variant definitions for a scope.
 * Returns undefined if the scope was never registered.
 */
export function getRegisteredVariant(name: string): VariantDefs | undefined {
  return registry.get(name);
}

/** Clear all registrations. Primarily used in tests. */
export function clearVariantRegistry(): void {
  registry.clear();
}
