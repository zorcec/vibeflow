import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useVariantContext } from "./context.js";
import { useActiveVariant } from "./useActiveVariant.js";
import type { SwitcherProps } from "./types.js";

/**
 * Component variant switcher with a subtle indicator dot.
 *
 * Shows a small, non-intrusive dot on the right (or left) side of the parent.
 * Clicking the dot expands the full numbered-dots picker.
 * Clicking outside or pressing Escape collapses it back.
 *
 * The dot is draggable — hold for 300ms, then drag to reposition anywhere on
 * the viewport. The new position is persisted to localStorage per scope name.
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

  // Scope registration is handled by useVariant in the parent subtree.
  // Only register if useVariant is not present (standalone usage).
  useEffect(() => {
    ctx.registerScope(name, variantKeys);
  }, [ctx, name, variantKeys]);

  const activeKey = useActiveVariant(name, variantKeys);

  // ── Drag-to-reposition state (same pattern as CornerTrigger) ────────────────
  // null = use default absolute positioning from the parent. Once dragged,
  // the element switches to position: fixed and persists to localStorage.

  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const saved = localStorage.getItem(`vf-variant-pos-${name}`);
      if (saved) {
        const parsed = JSON.parse(saved) as { x: number; y: number };
        if (typeof parsed.x === "number" && typeof parsed.y === "number")
          return parsed;
      }
    } catch { /* ignore */ }
    return null;
  });
  const [isDragging, setIsDragging] = useState(false);
  const [isHolding, setIsHolding] = useState(false);
  const dragOrigin = useRef<{
    mouseX: number;
    mouseY: number;
    posX: number;
    posY: number;
  } | null>(null);
  const holdTimer = useRef<number | null>(null);
  const didDrag = useRef(false);
  // Track pos in a ref so the hold-timer callback always has the latest value
  const posRef = useRef<{ x: number; y: number } | null>(null);
  posRef.current = pos;

  // Persist dragged position to localStorage
  useEffect(() => {
    if (pos !== null) {
      try {
        localStorage.setItem(`vf-variant-pos-${name}`, JSON.stringify(pos));
      } catch { /* ignore */ }
    }
  }, [pos, name]);

  // Clear hold timer on unmount to avoid memory leaks
  useEffect(() => {
    return () => {
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    };
  }, []);

  // Returns the current screen position of the container for drag start
  function getInitialPos() {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    }
    // Fallback: right edge of screen
    return { x: window.innerWidth - 48, y: window.innerHeight / 2 };
  }

  function onDotPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    // Capture values immediately — React clears currentTarget after the handler
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    const clientX = e.clientX;
    const clientY = e.clientY;
    didDrag.current = false;
    // Start hold timer — after 300ms, unlock dragging
    holdTimer.current = window.setTimeout(() => {
      setIsHolding(true);
      const startPos = posRef.current ?? getInitialPos();
      dragOrigin.current = {
        mouseX: clientX,
        mouseY: clientY,
        posX: startPos.x,
        posY: startPos.y,
      };
      target.setPointerCapture(pointerId);
    }, 300);
  }

  function onDotPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragOrigin.current) return;
    const dx = e.clientX - dragOrigin.current.mouseX;
    const dy = e.clientY - dragOrigin.current.mouseY;
    if (!isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3))
      setIsDragging(true);
    didDrag.current = true;
    const bw = window.innerWidth;
    const bh = window.innerHeight;
    const x = Math.max(8, Math.min(bw - 40, dragOrigin.current.posX + dx));
    const y = Math.max(8, Math.min(bh - 40, dragOrigin.current.posY + dy));
    setPos({ x, y });
  }

  function onDotPointerUp() {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    const wasDragged = didDrag.current;
    dragOrigin.current = null;
    setIsDragging(false);
    setIsHolding(false);
    didDrag.current = false;
    // Only expand if the dot was tapped without dragging
    if (!wasDragged) setExpanded(true);
  }

  function onDotPointerCancel() {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    dragOrigin.current = null;
    setIsDragging(false);
    setIsHolding(false);
    didDrag.current = false;
  }

  // ── Collapse on click outside ────────────────────────────────────────────────
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (
      containerRef.current &&
      !containerRef.current.contains(e.target as Node)
    ) {
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

  // ── Positioning: fixed when dragged, absolute (default) otherwise ────────────
  const sideStyle: React.CSSProperties =
    position === "left"
      ? { left: "-24px", right: "auto" }
      : { right: "-24px", left: "auto" };

  const containerStyle: React.CSSProperties =
    pos !== null
      ? {
          position: "fixed",
          left: pos.x,
          top: pos.y,
          transform: "none",
          zIndex: 9999,
        }
      : {
          position: "absolute",
          top: "50%",
          transform: "translateY(-50%)",
          ...sideStyle,
          zIndex: 9999,
        };

  const dotTitle = isDragging
    ? "Drag to reposition"
    : isHolding
      ? "Drag to reposition · Release to expand"
      : `${name} variants — click to switch · hold to drag`;

  return (
    <div
      ref={containerRef}
      role="toolbar"
      aria-label={`Component variant switcher: ${name}`}
      className="vf-variant-switcher"
      style={containerStyle}
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
        /* Collapsed: draggable indicator dot */
        <button
          aria-label={`Open variant switcher for ${name}`}
          title={dotTitle}
          onPointerDown={onDotPointerDown}
          onPointerMove={onDotPointerMove}
          onPointerUp={onDotPointerUp}
          onPointerCancel={onDotPointerCancel}
          style={{
            cursor: isDragging ? "grabbing" : isHolding ? "grab" : "pointer",
            border: "1px solid #e5e5e5",
            outline: "none",
            width: "14px",
            height: "14px",
            borderRadius: "50%",
            background: isDragging ? "#e5e5e5" : "#f5f5f5",
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: isDragging
              ? "0 2px 8px rgba(0,0,0,0.14)"
              : "0 1px 2px rgba(0,0,0,0.06)",
            transition: isDragging
              ? "none"
              : "background 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => {
            if (isDragging) return;
            e.currentTarget.style.background = "#e5e5e5";
            e.currentTarget.style.borderColor = "#d4d4d4";
          }}
          onMouseLeave={(e) => {
            if (isDragging) return;
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
