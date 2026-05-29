import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";
import { VariantProvider, useVariantContext } from "../src/context.js";

function ContextReader({ onContext }: { onContext: (ctx: ReturnType<typeof useVariantContext>) => void }) {
  const ctx = useVariantContext();
  onContext(ctx);
  return null;
}

describe("useKeyboardShortcuts — positive", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("Alt+H toggles uiVisible", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    expect(capturedCtx?.uiVisible).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "h", altKey: true, bubbles: true }));
    });
    expect(capturedCtx?.uiVisible).toBe(false);
  });

  it("Ctrl+Shift+V toggles uiVisible", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "V", ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(capturedCtx?.uiVisible).toBe(false);
  });
});

describe("useKeyboardShortcuts — negative (should NOT trigger)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("pressing h without Alt does NOT toggle uiVisible", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
    });
    expect(capturedCtx?.uiVisible).toBe(true); // unchanged
  });

  it("pressing Ctrl+h (with Alt) does NOT toggle — altKey+ctrlKey combo is not Alt+H", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", altKey: true, ctrlKey: true, bubbles: true }),
      );
    });
    expect(capturedCtx?.uiVisible).toBe(true); // Alt+Ctrl+H is not Alt+H
  });

  it("pressing Meta+h does NOT toggle — metaKey is excluded", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", altKey: true, metaKey: true, bubbles: true }),
      );
    });
    expect(capturedCtx?.uiVisible).toBe(true); // Meta+Alt+H should not trigger
  });

  it("pressing Ctrl+Shift+v (lowercase) does NOT toggle", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "v", ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(capturedCtx?.uiVisible).toBe(true); // lowercase v, not V
  });

  it("pressing Ctrl+V (without Shift) does NOT toggle", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "V", ctrlKey: true, shiftKey: false, bubbles: true }),
      );
    });
    expect(capturedCtx?.uiVisible).toBe(true); // Ctrl+V without Shift
  });

  it("pressing Ctrl+Shift+V with Alt does NOT toggle — altKey excluded", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "V",
          ctrlKey: true,
          shiftKey: true,
          altKey: true,
          bubbles: true,
        }),
      );
    });
    expect(capturedCtx?.uiVisible).toBe(true); // altKey present = excluded
  });

  it("pressing an unrelated key does NOT toggle", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(capturedCtx?.uiVisible).toBe(true);
  });
});

describe("useKeyboardShortcuts — configurable shortcuts", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("custom shortcut (Ctrl+K) toggles uiVisible", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider shortcuts={[{ key: "k", ctrl: true }]}>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    expect(capturedCtx?.uiVisible).toBe(true);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
      );
    });
    expect(capturedCtx?.uiVisible).toBe(false);
  });

  it("default shortcuts are disabled when custom shortcuts override them", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider shortcuts={[{ key: "k", ctrl: true }]}>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    // Alt+H should NOT work when shortcuts are overridden
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", altKey: true, bubbles: true }),
      );
    });
    expect(capturedCtx?.uiVisible).toBe(true); // unchanged
  });

  it("shortcuts=false disables all keyboard shortcuts", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider shortcuts={false}>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", altKey: true, bubbles: true }),
      );
    });
    expect(capturedCtx?.uiVisible).toBe(true); // unchanged — shortcuts disabled
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "V", ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(capturedCtx?.uiVisible).toBe(true); // still unchanged
  });
});
