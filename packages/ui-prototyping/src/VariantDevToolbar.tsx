import { useState, useEffect, useCallback } from "react";
import { useVariantContext } from "./context.js";

/**
 * Detects whether the Vibeflow overlay is present in the page.
 * Checks for the overlay's shadow DOM host element.
 */
function isOverlayPresent(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.getElementById("vibeflow-studio-root");
}

/**
 * Optional floating toolbar that shows all registered variant scopes.
 * Toggled via Ctrl+Shift+V keyboard shortcut or programmatically.
 *
 * **Vibeflow overlay integration:** When the Vibeflow overlay is detected,
 * the standalone ⚡ button is hidden. Instead, the toolbar is accessible
 * via the overlay's right-click context menu ("Prototyping" option).
 *
 * Place this once near the root of your app inside VariantProvider.
 *
 * @example
 * function App() {
 *   return (
 *     <VariantProvider>
 *       <VariantDevToolbar />
 *       <MainContent />
 *     </VariantProvider>
 *   )
 * }
 */
export function VariantDevToolbar() {
  const ctx = useVariantContext();
  const [isOpen, setIsOpen] = useState(false);
  const [overlayDetected, setOverlayDetected] = useState(false);

  // Detect overlay presence on mount
  useEffect(() => {
    setOverlayDetected(isOverlayPresent());
  }, []);

  const openPanel = useCallback(() => setIsOpen(true), []);
  const closePanel = useCallback(() => setIsOpen(false), []);

  // Register with the overlay if present
  useEffect(() => {
    if (!overlayDetected) return;

    // Expose API for the overlay to call
    const api = { openPanel, closePanel, isOpen };
    Object.defineProperty(window, "__vf_prototyping", {
      value: api,
      writable: true,
      configurable: true,
    });

    return () => {
      // Clean up on unmount — only if we still own it
      if ((window as any).__vf_prototyping === api) {
        delete (window as any).__vf_prototyping;
      }
    };
  }, [overlayDetected, openPanel, closePanel, isOpen]);

  const scopeEntries = Object.entries(ctx.scopes);

  if (!ctx.uiVisible && !isOpen) return null;

  return (
    <>
      {/* Toggle button — hidden when overlay is detected (overlay provides its own entry point) */}
      {ctx.uiVisible && !overlayDetected && (
        <button
          aria-label="Toggle variant dev toolbar"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((p) => !p)}
          style={{
            position: "fixed",
            bottom: "16px",
            right: "16px",
            zIndex: 99998,
            width: "40px",
            height: "40px",
            borderRadius: "50%",
            background: "#171717",
            color: "#fff",
            border: "none",
            cursor: "pointer",
            fontSize: "18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 2px 8px rgba(0,0,0,0.32)",
            transition: "background 0.15s",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          }}
          title="Open variant dev toolbar (Ctrl+Shift+V)"
        >
          ⚡
        </button>
      )}

      {/* Toolbar panel */}
      {isOpen && (
        <div
          role="dialog"
          aria-label="Variant dev toolbar"
          style={{
            position: "fixed",
            bottom: "68px",
            right: "16px",
            zIndex: 99999,
            background: "#fff",
            border: "1px solid #e5e5e5",
            borderRadius: "12px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.16)",
            padding: "16px",
            minWidth: "240px",
            maxWidth: "360px",
            maxHeight: "70vh",
            overflowY: "auto",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            fontSize: "13px",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "12px",
            }}
          >
            <span style={{ fontWeight: 700, color: "#171717", fontSize: "13px" }}>
              ⚡ Variant Switcher
            </span>
            <button
              aria-label="Close toolbar"
              onClick={() => setIsOpen(false)}
              style={{
                border: "none",
                background: "none",
                cursor: "pointer",
                fontSize: "16px",
                color: "#737373",
                padding: "2px 4px",
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>

          {/* Hint */}
          <div
            style={{
              fontSize: "11px",
              color: "#a3a3a3",
              marginBottom: "12px",
            }}
          >
            Alt+H to toggle • Ctrl+Shift+V to open
          </div>

          {/* Scope list */}
          {scopeEntries.length === 0 ? (
            <div style={{ color: "#a3a3a3", fontSize: "12px" }}>
              No variant scopes registered yet.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {scopeEntries.map(([scopeName, state]) => (
                <ScopeControl
                  key={scopeName}
                  name={scopeName}
                  state={state}
                  onSelect={(variant) =>
                    ctx.setActiveVariant(scopeName, variant)
                  }
                />
              ))}
            </div>
          )}

          {/* UI toggle */}
          <div
            style={{
              marginTop: "16px",
              paddingTop: "12px",
              borderTop: "1px solid #f0f0f0",
            }}
          >
            <button
              onClick={ctx.toggleUiVisible}
              style={{
                width: "100%",
                padding: "7px 12px",
                border: "1px solid #e5e5e5",
                borderRadius: "6px",
                background: "none",
                cursor: "pointer",
                fontSize: "12px",
                color: "#737373",
                textAlign: "center",
              }}
            >
              {ctx.uiVisible ? "Hide switchers (Alt+H)" : "Show switchers (Alt+H)"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Internal helper component
// ---------------------------------------------------------------------------

interface ScopeControlProps {
  name: string;
  state: { activeVariant: string; variantNames: string[] };
  onSelect: (variant: string) => void;
}

function ScopeControl({ name, state, onSelect }: ScopeControlProps) {
  return (
    <div>
      <div
        style={{
          fontWeight: 600,
          color: "#404040",
          marginBottom: "6px",
          fontSize: "12px",
        }}
      >
        {name}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
        {state.variantNames.map((key) => {
          const isActive = key === state.activeVariant;
          return (
            <button
              key={key}
              role="radio"
              aria-checked={isActive}
              aria-label={`Switch ${name} to ${key}`}
              onClick={() => onSelect(key)}
              style={{
                cursor: "pointer",
                border: isActive ? "2px solid #171717" : "1px solid #e5e5e5",
                borderRadius: "5px",
                padding: "3px 10px",
                fontSize: "11px",
                fontWeight: isActive ? 600 : 400,
                background: isActive ? "#171717" : "#fafafa",
                color: isActive ? "#fff" : "#404040",
                transition: "all 0.12s",
              }}
            >
              {key}
            </button>
          );
        })}
      </div>
    </div>
  );
}
