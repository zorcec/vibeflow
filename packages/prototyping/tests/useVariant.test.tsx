import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React, { useEffect } from "react";
import { VariantProvider, useVariantContext } from "../src/context.js";
import { useVariant } from "../src/useVariant.js";
import { clearVariantRegistry, registerVariant } from "../src/registry.js";

const demoVariants = {
  default: { label: "Default variant" },
  compact: { label: "Compact variant", size: "sm" },
  detailed: { label: "Detailed variant", extra: true },
};

function DemoComponent({ onVariant }: { onVariant?: (v: typeof demoVariants[keyof typeof demoVariants]) => void }) {
  const variant = useVariant("Demo", demoVariants);
  onVariant?.(variant);
  return <div data-testid="variant-label">{variant.label}</div>;
}

describe("useVariant", () => {
  beforeEach(() => {
    localStorage.clear();
    clearVariantRegistry();
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/"),
    });
  });

  afterEach(() => {
    clearVariantRegistry();
  });

  it("returns the first variant (default) when nothing stored", () => {
    render(
      <VariantProvider>
        <DemoComponent />
      </VariantProvider>,
    );
    expect(screen.getByTestId("variant-label").textContent).toBe("Default variant");
  });

  it("returns the variant stored in localStorage", () => {
    localStorage.setItem("__vf__Demo", "compact");
    render(
      <VariantProvider>
        <DemoComponent />
      </VariantProvider>,
    );
    expect(screen.getByTestId("variant-label").textContent).toBe("Compact variant");
  });

  it("returns the variant from URL over localStorage", () => {
    localStorage.setItem("__vf__Demo", "compact");
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/?vf%5BDemo%5D=detailed"),
    });
    render(
      <VariantProvider>
        <DemoComponent />
      </VariantProvider>,
    );
    expect(screen.getByTestId("variant-label").textContent).toBe("Detailed variant");
  });

  it("registers the scope with the provider on mount", () => {
    let capturedScopes: Record<string, unknown> = {};

    function ScopeChecker() {
      const ctx = useVariantContext();
      capturedScopes = ctx.scopes;
      return null;
    }

    function ScopeRegistrar() {
      useVariant("MyScopeCheck", demoVariants);
      return null;
    }

    render(
      <VariantProvider>
        <ScopeRegistrar />
        <ScopeChecker />
      </VariantProvider>,
    );

    // The scope must be registered in context
    expect(capturedScopes["MyScopeCheck"]).toBeDefined();
    expect(capturedScopes["MyScopeCheck"]).toMatchObject({
      variantNames: ["default", "compact", "detailed"],
    });
  });

  it("merges registered variants with inline variants (registry base key preserved, inline wins on conflict)", () => {
    registerVariant("MergeTest", {
      base: { from: "registry", preserved: true },
      overlap: { from: "registry", willBeReplaced: true },
    });

    const inlineVariants = {
      overlap: { from: "inline" },
      extra: { new: true },
    };

    let capturedVariantNames: string[] = [];

    function MergedComp() {
      const ctx = useVariantContext();
      // We capture variant keys registered in context
      useEffect(() => {
        capturedVariantNames = ctx.scopes["MergeTest"]?.variantNames ?? [];
      });
      return null;
    }

    // First render to trigger registration
    function SpyVariant() {
      const v = useVariant("MergeTest", inlineVariants);
      void v;
      return null;
    }

    render(
      <VariantProvider>
        <SpyVariant />
        <MergedComp />
      </VariantProvider>,
    );

    // Merged keys should include: base (from registry), overlap, extra
    expect(capturedVariantNames).toContain("base");
    expect(capturedVariantNames).toContain("overlap");
    expect(capturedVariantNames).toContain("extra");
  });

  it("the merged result includes registry base variant value when active variant is 'base'", () => {
    registerVariant("MergeBase", {
      base: { origin: "registry", extra: 42 },
    });

    const inlineVariants = {
      other: { origin: "inline" },
    };

    let capturedActiveVariant: Record<string, unknown> | null = null;

    function SpyComp() {
      const ctx = useVariantContext();
      // Force-select "base" after registration
      useEffect(() => {
        ctx.setActiveVariant("MergeBase", "base");
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return null;
    }

    function SpyVariant() {
      const v = useVariant("MergeBase", inlineVariants);
      capturedActiveVariant = v as Record<string, unknown>;
      return null;
    }

    render(
      <VariantProvider>
        <SpyVariant />
        <SpyComp />
      </VariantProvider>,
    );

    // After setActiveVariant("base"), the variant should come from registry
    expect(capturedActiveVariant).toMatchObject({ origin: "registry", extra: 42 });
  });

  it("handles empty object as variant config", () => {
    const emptyVariants = { plain: {}, withStuff: { x: 1 } };

    function EmptyComp() {
      const v = useVariant("Empty", emptyVariants);
      return <div data-testid="empty">{JSON.stringify(v)}</div>;
    }

    render(
      <VariantProvider>
        <EmptyComp />
      </VariantProvider>,
    );
    expect(screen.getByTestId("empty").textContent).toBe("{}");
  });

  it("falls back to resolveActiveVariant when context has no stored active for scope", () => {
    // Store a localStorage variant
    localStorage.setItem("__vf__FreshScope", "compact");

    function FreshComp() {
      const v = useVariant("FreshScope", demoVariants);
      return <div data-testid="fresh-label">{v.label}</div>;
    }

    render(
      <VariantProvider>
        <FreshComp />
      </VariantProvider>,
    );

    // Scope was not yet in context; resolveActiveVariant reads from localStorage
    expect(screen.getByTestId("fresh-label").textContent).toBe("Compact variant");
  });

  it("context's getActiveVariant reflects the stored variant after setActiveVariant", () => {
    let capturedCtx: ReturnType<typeof useVariantContext> | null = null;

    function Spy() {
      const ctx = useVariantContext();
      capturedCtx = ctx;
      useVariant("SetTest", demoVariants);
      return null;
    }

    render(
      <VariantProvider>
        <Spy />
      </VariantProvider>,
    );

    act(() => {
      capturedCtx?.setActiveVariant("SetTest", "detailed");
    });

    expect(capturedCtx?.getActiveVariant("SetTest")).toBe("detailed");
  });
});
