import { describe, it, expect } from "vitest";
import { detectReactQuality } from "../../src/client/overlay-browser/react-detect.js";
import type { ReactQualityLevel } from "../../src/client/overlay-browser/react-detect.js";

// Builds a minimal mock "document" whose querySelectorAll returns elements
// with controllable React fiber keys — no DOM/jsdom required.
function mockRoot(elements: Record<string, unknown>[]): Document {
  return {
    querySelectorAll: () => elements,
  } as unknown as Document;
}

function reactElem(fiberData: Record<string, unknown>): Record<string, unknown> {
  const key = "__reactFiber$abc123";
  return { [key]: fiberData };
}

describe("detectReactQuality", () => {
  it("returns 'not-react' when no React fiber keys exist", () => {
    const root = mockRoot([{ id: "foo" }, { className: "bar" }]);
    expect(detectReactQuality(root)).toBe<ReactQualityLevel>("not-react");
  });

  it("returns 'not-react' for an empty element list", () => {
    const root = mockRoot([]);
    expect(detectReactQuality(root)).toBe<ReactQualityLevel>("not-react");
  });

  it("returns 'full' when _debugSource is present on fiber", () => {
    const root = mockRoot([
      reactElem({ _debugSource: { fileName: "/src/App.tsx", lineNumber: 42 }, _debugOwner: { type: "App" } }),
    ]);
    expect(detectReactQuality(root)).toBe<ReactQualityLevel>("full");
  });

  it("returns 'partial' when _debugOwner exists but no _debugSource", () => {
    const root = mockRoot([
      reactElem({ _debugOwner: { type: "Header" } }),
    ]);
    expect(detectReactQuality(root)).toBe<ReactQualityLevel>("partial");
  });

  it("returns 'none' when React fiber exists but no debug info (production build)", () => {
    const root = mockRoot([
      reactElem({}),
    ]);
    expect(detectReactQuality(root)).toBe<ReactQualityLevel>("none");
  });

  it("returns 'full' if any element has _debugSource even when others lack it", () => {
    const root = mockRoot([
      reactElem({}),
      reactElem({ _debugOwner: { type: "App" } }),
      reactElem({ _debugSource: { fileName: "/src/Button.tsx", lineNumber: 10 }, _debugOwner: {} }),
    ]);
    expect(detectReactQuality(root)).toBe<ReactQualityLevel>("full");
  });

  it("returns 'partial' if some elements have _debugOwner and none have _debugSource", () => {
    const root = mockRoot([
      reactElem({}),
      reactElem({ _debugOwner: { type: "Sidebar" } }),
    ]);
    expect(detectReactQuality(root)).toBe<ReactQualityLevel>("partial");
  });

  it("recognises __reactInternalInstance keys in addition to __reactFiber$", () => {
    const elem: Record<string, unknown> = {
      "__reactInternalInstanceXYZ": { _debugOwner: { type: "Legacy" } },
    };
    const root = mockRoot([elem]);
    expect(detectReactQuality(root)).toBe<ReactQualityLevel>("partial");
  });
});
