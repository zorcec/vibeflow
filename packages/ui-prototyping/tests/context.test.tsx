import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { VariantProvider, useVariantContext } from "../src/context.js";

// Test helper: a component that reads from context and exposes it
function ContextReader({ onContext }: { onContext: (ctx: ReturnType<typeof useVariantContext>) => void }) {
  const ctx = useVariantContext();
  onContext(ctx);
  return null;
}

describe("VariantProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders children", () => {
    render(
      <VariantProvider>
        <div data-testid="child">hello</div>
      </VariantProvider>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("provides default mode as 'dev'", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    expect(capturedCtx?.mode).toBe("dev");
  });

  it("provides 'always' mode when specified", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider mode="always">
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    expect(capturedCtx?.mode).toBe("always");
  });

  it("uiVisible defaults to true", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    expect(capturedCtx?.uiVisible).toBe(true);
  });

  it("registers a scope via registerScope", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;

    function RegistrarComponent() {
      const ctx = useVariantContext();
      capturedCtx = ctx;
      React.useEffect(() => {
        ctx.registerScope("TestScope", ["a", "b", "c"]);
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return null;
    }

    render(
      <VariantProvider>
        <RegistrarComponent />
      </VariantProvider>,
    );

    expect(capturedCtx?.scopes["TestScope"]).toBeDefined();
    expect(capturedCtx?.scopes["TestScope"]?.variantNames).toEqual(["a", "b", "c"]);
  });

  it("setActiveVariant updates the scope", async () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;

    function TestComponent() {
      const ctx = useVariantContext();
      capturedCtx = ctx;
      React.useEffect(() => {
        ctx.registerScope("S", ["x", "y"]);
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return (
        <button onClick={() => ctx.setActiveVariant("S", "y")}>
          switch
        </button>
      );
    }

    const user = userEvent.setup();
    render(
      <VariantProvider>
        <TestComponent />
      </VariantProvider>,
    );

    await user.click(screen.getByText("switch"));
    expect(capturedCtx?.getActiveVariant("S")).toBe("y");
  });

  it("toggleUiVisible flips visibility", async () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;

    function TestComponent() {
      const ctx = useVariantContext();
      capturedCtx = ctx;
      return <button onClick={ctx.toggleUiVisible}>toggle</button>;
    }

    const user = userEvent.setup();
    render(
      <VariantProvider>
        <TestComponent />
      </VariantProvider>,
    );

    expect(capturedCtx?.uiVisible).toBe(true);
    await user.click(screen.getByText("toggle"));
    expect(capturedCtx?.uiVisible).toBe(false);
    await user.click(screen.getByText("toggle"));
    expect(capturedCtx?.uiVisible).toBe(true);
  });

  it("reads persisted uiVisible from localStorage", () => {
    localStorage.setItem("__vf__ui_visible__", "false");
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    expect(capturedCtx?.uiVisible).toBe(false);
  });

  it("defaultVisible overrides when nothing in storage", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;
    render(
      <VariantProvider defaultVisible={false}>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );
    expect(capturedCtx?.uiVisible).toBe(false);
  });

  it("throws when useVariantContext used outside provider", () => {
    const consoleError = console.error;
    console.error = () => {}; // suppress React error boundary noise

    expect(() => render(<ContextReader onContext={() => {}} />)).toThrow(
      "useVariantContext must be used inside <VariantProvider>",
    );

    console.error = consoleError;
  });
});

describe("VariantProvider keyboard shortcuts", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("Alt+H toggles uiVisible", async () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;

    render(
      <VariantProvider>
        <ContextReader onContext={(ctx) => { capturedCtx = ctx; }} />
      </VariantProvider>,
    );

    expect(capturedCtx?.uiVisible).toBe(true);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", altKey: true, bubbles: true }),
      );
    });

    expect(capturedCtx?.uiVisible).toBe(false);
  });

  it("Ctrl+Shift+V toggles uiVisible", async () => {
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
          bubbles: true,
        }),
      );
    });

    expect(capturedCtx?.uiVisible).toBe(false);
  });
});
