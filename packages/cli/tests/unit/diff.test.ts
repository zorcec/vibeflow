import { describe, it, expect } from "vitest";
import { computeDiff, summarizeDiff } from "../../src/core/diff.js";
import type { DomSnapshot, DiffResult } from "../../src/core/diff.js";

function makeSnapshot(overrides: Partial<DomSnapshot> = {}): DomSnapshot {
  return {
    outerHTML: '<button class="submit">Submit</button>',
    computedStyles: {
      "background-color": "#EF4444",
      color: "#FFFFFF",
      fontSize: "14px",
    },
    selector: ".submit",
    position: {
      boundingBox: { x: 100, y: 200, width: 120, height: 40 },
      scrollPosition: { x: 0, y: 0 },
      viewport: { width: 1280, height: 720, dpr: 2 },
      stackingContext: { zIndex: "auto", position: "relative" },
    },
    browser: "Mozilla/5.0",
    consoleErrors: ["existing error"],
    capturedAt: "2026-08-28T22:07:00.000Z",
    ...overrides,
  };
}

describe("computeDiff", () => {
  it("detects no changes when snapshots are identical", () => {
    const snap = makeSnapshot();
    const diff = computeDiff(snap, makeSnapshot());
    expect(diff).toEqual({
      selectorResolves: true,
      htmlChanged: false,
      stylesChanged: {},
      positionChanged: false,
      newConsoleErrors: [],
    });
  });

  it("detects HTML changes", () => {
    const baseline = makeSnapshot();
    const after = makeSnapshot({
      outerHTML: '<button class="submit submit--blue">Submit</button>',
    });
    const diff = computeDiff(baseline, after);
    expect(diff.htmlChanged).toBe(true);
  });

  it("detects style changes", () => {
    const baseline = makeSnapshot();
    const after = makeSnapshot({
      computedStyles: {
        "background-color": "#3B82F6",
        color: "#FFFFFF",
        fontSize: "14px",
      },
    });
    const diff = computeDiff(baseline, after);
    expect(diff.stylesChanged).toEqual({
      "background-color": ["#EF4444", "#3B82F6"],
    });
  });

  it("detects new style properties", () => {
    const baseline = makeSnapshot({ computedStyles: { color: "#000" } });
    const after = makeSnapshot({ computedStyles: { color: "#000", padding: "8px" } });
    const diff = computeDiff(baseline, after);
    expect(diff.stylesChanged).toEqual({
      padding: ["", "8px"],
    });
  });

  it("detects removed style properties", () => {
    const baseline = makeSnapshot({ computedStyles: { color: "#000", padding: "8px" } });
    const after = makeSnapshot({ computedStyles: { color: "#000" } });
    const diff = computeDiff(baseline, after);
    expect(diff.stylesChanged).toEqual({
      padding: ["8px", ""],
    });
  });

  it("detects position shifts beyond tolerance", () => {
    const baseline = makeSnapshot();
    const after = makeSnapshot({
      position: {
        boundingBox: { x: 100, y: 250, width: 120, height: 40 },
        scrollPosition: { x: 0, y: 0 },
        viewport: { width: 1280, height: 720, dpr: 2 },
        stackingContext: { zIndex: "auto", position: "relative" },
      },
    });
    const diff = computeDiff(baseline, after);
    expect(diff.positionChanged).toBe(true);
  });

  it("ignores small position jitter within tolerance", () => {
    const baseline = makeSnapshot();
    const after = makeSnapshot({
      position: {
        boundingBox: { x: 101, y: 201, width: 119, height: 41 },
        scrollPosition: { x: 0, y: 0 },
        viewport: { width: 1280, height: 720, dpr: 2 },
        stackingContext: { zIndex: "auto", position: "relative" },
      },
    });
    const diff = computeDiff(baseline, after);
    expect(diff.positionChanged).toBe(false);
  });

  it("filters out baseline console errors from new errors", () => {
    const baseline = makeSnapshot({ consoleErrors: ["error A", "error B"] });
    const after = makeSnapshot({ consoleErrors: ["error A", "error C"] });
    const diff = computeDiff(baseline, after);
    expect(diff.newConsoleErrors).toEqual(["error C"]);
  });

  it("handles empty baseline errors", () => {
    const baseline = makeSnapshot({ consoleErrors: [] });
    const after = makeSnapshot({ consoleErrors: ["new error"] });
    const diff = computeDiff(baseline, after);
    expect(diff.newConsoleErrors).toEqual(["new error"]);
  });

  it("handles empty after outerHTML (selector not found)", () => {
    const baseline = makeSnapshot();
    const after = makeSnapshot({ outerHTML: "" });
    const diff = computeDiff(baseline, after);
    expect(diff.selectorResolves).toBe(false);
  });

  it("handles completely empty after snapshot", () => {
    const baseline = makeSnapshot();
    const after: DomSnapshot = {
      outerHTML: "",
      computedStyles: {},
      selector: ".submit",
      position: baseline.position,
      browser: "",
      consoleErrors: [],
      capturedAt: new Date().toISOString(),
    };
    const diff = computeDiff(baseline, after);
    expect(diff.selectorResolves).toBe(false);
    expect(diff.htmlChanged).toBe(true);
    expect(Object.keys(diff.stylesChanged).length).toBeGreaterThan(0);
  });
});

describe("summarizeDiff", () => {
  it("reports no changes", () => {
    const diff: DiffResult = {
      selectorResolves: true,
      htmlChanged: false,
      stylesChanged: {},
      positionChanged: false,
      newConsoleErrors: [],
    };
    expect(summarizeDiff(diff, ".submit")).toBe("no structural changes detected");
  });

  it("reports HTML changed", () => {
    const diff: DiffResult = {
      selectorResolves: true,
      htmlChanged: true,
      stylesChanged: {},
      positionChanged: false,
      newConsoleErrors: [],
    };
    expect(summarizeDiff(diff, ".submit")).toBe("HTML changed");
  });

  it("reports style changes with property names", () => {
    const diff: DiffResult = {
      selectorResolves: true,
      htmlChanged: false,
      stylesChanged: { "background-color": ["red", "blue"] },
      positionChanged: false,
      newConsoleErrors: [],
    };
    const summary = summarizeDiff(diff, ".submit");
    expect(summary).toContain("1 style property change(s)");
    expect(summary).toContain("background-color");
  });

  it("truncates style list when more than 5", () => {
    const stylesChanged: Record<string, [string, string]> = {};
    for (let i = 0; i < 8; i++) {
      stylesChanged[`prop-${i}`] = ["old", "new"];
    }
    const diff: DiffResult = {
      selectorResolves: true,
      htmlChanged: false,
      stylesChanged,
      positionChanged: false,
      newConsoleErrors: [],
    };
    const summary = summarizeDiff(diff, ".submit");
    expect(summary).toContain("8 style property change(s)");
    expect(summary).toContain("(+3 more)");
  });

  it("reports selector not found", () => {
    const diff: DiffResult = {
      selectorResolves: false,
      htmlChanged: true,
      stylesChanged: {},
      positionChanged: false,
      newConsoleErrors: [],
    };
    const summary = summarizeDiff(diff, ".submit");
    expect(summary).toContain('Selector ".submit" no longer resolves');
  });

  it("reports console errors", () => {
    const diff: DiffResult = {
      selectorResolves: true,
      htmlChanged: false,
      stylesChanged: {},
      positionChanged: false,
      newConsoleErrors: ["TypeError: x is not a function"],
    };
    const summary = summarizeDiff(diff, ".submit");
    expect(summary).toContain("1 new console error(s)");
  });

  it("combines multiple change types", () => {
    const diff: DiffResult = {
      selectorResolves: true,
      htmlChanged: true,
      stylesChanged: { color: ["red", "blue"] },
      positionChanged: true,
      newConsoleErrors: [],
    };
    const summary = summarizeDiff(diff, ".submit");
    expect(summary).toContain("HTML changed");
    expect(summary).toContain("1 style property change(s)");
    expect(summary).toContain("position shifted");
  });
});
