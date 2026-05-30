import { useEffect, useMemo } from "react";
import { useVariantContext } from "./context.js";
import { useActiveVariant } from "./useActiveVariant.js";

interface PageVariantSwitcherProps {
  /** Scope name — must match the first argument of useVariant. */
  name: string;
  /** Variant definitions — same as passed to useVariant. */
  variants: Record<string, Record<string, unknown>>;
}

/**
 * Dark segmented bar floating top-left of the page.
 * Renders automatically via VariantProvider for page-level variant switching.
 *
 * Place this component anywhere inside VariantProvider — typically at the
 * top of the page component alongside useVariant.
 *
 * @example
 * function App() {
 *   const layout = useVariant('Layout', layoutVariants)
 *   return (
 *     <>
 *       <PageVariantSwitcher name="Layout" variants={layoutVariants} />
 *       <main>…</main>
 *     </>
 *   )
 * }
 */
export function PageVariantSwitcher({
  name,
  variants,
}: PageVariantSwitcherProps) {
  const ctx = useVariantContext();
  const variantKeys = useMemo(() => Object.keys(variants), [variants]);

  // Scope registration is handled by useVariant in the parent subtree.
  // Only register if useVariant is not present (standalone usage).
  useEffect(() => {
    ctx.registerScope(name, variantKeys);
  }, [ctx, name, variantKeys]);

  const activeKey = useActiveVariant(name, variantKeys);

  if (!ctx.uiVisible) return null;
  if (variantKeys.length < 2) return null;

  return (
    <div
      role="toolbar"
      aria-label={`Page variant switcher: ${name}`}
      style={{
        position: "fixed",
        top: "12px",
        left: "12px",
        zIndex: 99999,
        display: "flex",
        alignItems: "center",
        background: "#171717",
        borderRadius: "8px",
        padding: "4px",
        gap: "2px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.32)",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: "12px",
        userSelect: "none",
      }}
    >
      {variantKeys.map((key) => {
        const isActive = key === activeKey;
        return (
          <button
            key={key}
            role="radio"
            aria-checked={isActive}
            aria-label={`Switch to ${key} variant`}
            onClick={() => ctx.setActiveVariant(name, key)}
            style={{
              cursor: "pointer",
              border: "none",
              outline: "none",
              borderRadius: "5px",
              padding: "5px 12px",
              fontSize: "12px",
              fontWeight: isActive ? 600 : 400,
              background: isActive ? "#ffffff" : "transparent",
              color: isActive ? "#171717" : "#a3a3a3",
              transition: "background 0.15s, color 0.15s",
              whiteSpace: "nowrap",
            }}
          >
            {key}
          </button>
        );
      })}
    </div>
  );
}
