import { useEffect, useMemo, useState } from "react";
import { useVariantContext } from "./context.js";
import { resolveActiveVariant } from "./utils.js";
import type { SwitcherProps } from "./types.js";

/**
 * Numbered dots component switcher.
 *
 * Floats vertically centered outside the component (right or left side).
 * Hidden by default — appears on parent hover or via Alt+H keyboard shortcut.
 *
 * The parent element must have `position: relative` for correct placement.
 *
 * @example
 * function TaskCard({ task }) {
 *   const variant = useVariant('TaskCard', taskCardVariants)
 *   return (
 *     <div style={{ position: 'relative' }}>
 *       <VariantSwitcher name="TaskCard" variants={taskCardVariants} />
 *       {variant.compact ? <CompactView /> : <FullView />}
 *     </div>
 *   )
 * }
 */
export function VariantSwitcher({
  name,
  variants,
  position = "right",
}: SwitcherProps) {
  const ctx = useVariantContext();
  const variantKeys = useMemo(() => Object.keys(variants), [variants]);

  // Dedup: only the first VariantSwitcher per scope renders
  const [isPrimary, setIsPrimary] = useState(false);

  useEffect(() => {
    const primary = ctx.registerSwitcher(name);
    setIsPrimary(primary);
    return () => {
      ctx.unregisterSwitcher(name);
    };
  }, [ctx, name]);

  // Register scope
  useEffect(() => {
    ctx.registerScope(name, variantKeys);
  }, [ctx, name, variantKeys]);

  const activeKey = useMemo(() => {
    const current = ctx.getActiveVariant(name);
    if (current && variantKeys.includes(current)) return current;
    return resolveActiveVariant(name, variantKeys, variantKeys[0] ?? "default");
  }, [ctx, name, variantKeys]);

  if (!ctx.uiVisible) return null;
  if (variantKeys.length < 2) return null;
  if (!isPrimary) return null;

  const sideStyle: React.CSSProperties =
    position === "left"
      ? { left: "-28px", right: "auto" }
      : { right: "-28px", left: "auto" };

  return (
    <div
      role="toolbar"
      aria-label={`Component variant switcher: ${name}`}
      className="vf-variant-switcher"
      style={{
        position: "absolute",
        top: "50%",
        transform: "translateY(-50%)",
        ...sideStyle,
        display: "flex",
        flexDirection: "column",
        gap: "3px",
        zIndex: 9999,
        background: "#fff",
        border: "1px solid #e5e5e5",
        borderRadius: "4px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        padding: "3px",
        opacity: 0,
        transition: "opacity 0.15s",
        pointerEvents: "none",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      {/* CSS for hover — injected via a <style> tag on first render */}
      <VariantSwitcherStyles />
      {variantKeys.map((key, index) => {
        const isActive = key === activeKey;
        return (
          <button
            key={key}
            role="radio"
            aria-checked={isActive}
            aria-label={`Switch to ${key} variant (${index + 1})`}
            onClick={() => ctx.setActiveVariant(name, key)}
            title={key}
            style={{
              cursor: "pointer",
              border: "none",
              outline: "none",
              width: "22px",
              height: "22px",
              borderRadius: "3px",
              fontSize: "10px",
              fontWeight: isActive ? 700 : 400,
              background: isActive ? "#171717" : "transparent",
              color: isActive ? "#fff" : "#737373",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background 0.12s, color 0.12s",
              padding: 0,
              lineHeight: 1,
            }}
          >
            {index + 1}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Injects the hover CSS rule that makes .vf-variant-switcher visible
 * when the parent element is hovered.
 * Uses a singleton pattern — only injected once per document.
 */
let stylesInjected = false;

function VariantSwitcherStyles() {
  if (typeof document !== "undefined" && !stylesInjected) {
    stylesInjected = true;
    const style = document.createElement("style");
    style.dataset["vfSwitcher"] = "1";
    style.textContent = `
      *:hover > .vf-variant-switcher,
      .vf-variant-switcher:hover {
        opacity: 1 !important;
        pointer-events: auto !important;
      }
    `;
    document.head.appendChild(style);
  }
  return null;
}

/**
 * Reset the styles-injected flag and remove injected style tag.
 * Used in tests only to ensure a clean slate between test runs.
 */
export function _resetStylesInjected(): void {
  stylesInjected = false;
  if (typeof document !== "undefined") {
    document.head.querySelectorAll("[data-vf-switcher]").forEach((el) => el.remove());
  }
}
