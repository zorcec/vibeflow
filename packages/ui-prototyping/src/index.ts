/**
 * @vibeflow-tools/ui-prototyping
 *
 * In-app variant switching for React — page-level and component-level
 * prototyping with URL persistence and zero runtime dependencies.
 *
 * @example
 * import {
 *   VariantProvider,
 *   useVariant,
 *   VariantSwitcher,
 *   PageVariantSwitcher,
 *   VariantDevToolbar,
 *   registerVariant,
 * } from '@vibeflow-tools/ui-prototyping'
 */

export { VariantProvider, VariantContext, useVariantContext } from "./context.js";
export { useVariant } from "./useVariant.js";
export { useActiveVariant } from "./useActiveVariant.js";
export { useKeyboardShortcuts } from "./useKeyboardShortcuts.js";
export type { KeyboardShortcut } from "./useKeyboardShortcuts.js";
export { PageVariantSwitcher } from "./PageVariantSwitcher.js";
export { VariantSwitcher } from "./VariantSwitcher.js";
export { VariantDevToolbar } from "./VariantDevToolbar.js";
export { registerVariant, getRegisteredVariant, clearVariantRegistry } from "./registry.js";

// URL/localStorage utils — exported for power users who need manual control
export {
  readVariantFromUrl,
  writeVariantToUrl,
  removeVariantFromUrl,
  readVariantFromStorage,
  writeVariantToStorage,
  removeVariantFromStorage,
  resolveActiveVariant,
  readUiVisibleFromStorage,
  writeUiVisibleToStorage,
} from "./utils.js";

export type {
  VariantDefinitions,
  VariantMode,
  VariantState,
  VariantContextValue,
  VariantProviderProps,
  SwitcherProps,
} from "./types.js";
