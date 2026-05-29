import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useVariantContext } from "./context.js";
import { resolveActiveVariant } from "./utils.js";
import type { SwitcherProps } from "./types.js";

/**
 * Component variant switcher with a subtle indicator dot.
 *
 * Shows a small, non-intrusive dot on the right (or left) side of the parent.
 * Clicking the dot expands the full numbered-dots picker.
 * Clicking outside or pressing Escape collapses it back.
 *
 * Deduplicates per scope — only the first VariantSwitcher for a given
 * scope renders. Multiple components using the same scope share one switcher.
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
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Collapse on click outside
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setExpanded(false);
    }
  }, []);

  useEffect(() => {
    if (expanded) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [expanded, handleClickOutside]);

  // Collapse on Escape
  useEffect(() => {
    if (!expanded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [expanded]);

  if (!ctx.uiVisible) return null;
  if (variantKeys.length < 2) return null;
  if (!isPrimary) return null;

  const sideStyle: React.CSSProperties =
    position === "left"
      ? { left: "-24px", right: "auto" }
      : { right: "-24px", left: "auto" };

  const activeIndex = variantKeys.indexOf(activeKey);

  return (
    <div
      ref={containerRef}
      role="toolbar"
      aria-label={`Component variant switcher: ${name}`}
      className="vf-variant-switcher"
      style={{
        position: "absolute",
        top: "50%",
        transform: "translateY(-50%)",
        ...sideStyle,
        zIndex: 9999,
      }}
    >
      {/* Expanded: full numbered dots picker */}
      {expanded ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "3px",
            background: "#fff",
            border: "1px solid #e5e5e5",
            borderRadius: "4px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
            padding: "3px",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          }}
        >
          {variantKeys.map((key, index) => {
            const isActive = key === activeKey;
            return (
              <button
                key={key}
                role="radio"
                aria-checked={isActive}
                aria-label={`Switch to ${key} variant (${index + 1})`}
                onClick={() => {
                  ctx.setActiveVariant(name, key);
                  setExpanded(false);
                }}
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
      ) : (
        /* Collapsed: subtle indicator dot */
        <button
          onClick={() => setExpanded(true)}
          aria-label={`Open variant switcher for ${name}`}
          title={`${name} variants — click to switch`}
          style={{
            cursor: "pointer",
            border: "1px solid #e5e5e5",
            outline: "none",
            width: "14px",
            height: "14px",
            borderRadius: "50%",
            background: "#f5f5f5",
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
            transition: "background 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#e5e5e5";
            e.currentTarget.style.borderColor = "#d4d4d4";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "#f5f5f5";
            e.currentTarget.style.borderColor = "#e5e5e5";
          }}
        >
          {/* Active variant indicator — tiny inner dot */}
          <span
            style={{
              width: "5px",
              height: "5px",
              borderRadius: "50%",
              background: "#a3a3a3",
            }}
          />
        </button>
      )}
    </div>
  );
}

/**
 * Reset styles. Used in tests only.
 */
export function _resetStylesInjected(): void {
  // No-op — styles are no longer injected
}
