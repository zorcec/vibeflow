import { describe, it, expect } from "vitest";
import {
  diffPageStyles,
  summarizeStyleDiff,
  queryStyleProperty,
  queryChildChanges,
  queryTextChanges,
  queryAttributeChanges,
} from "../../src/core/page-diff.js";
import type { PageSnapshot } from "../../src/core/page-types.js";

function makeSnapshot(
  elements: Record<
    string,
    { selector: string; childCount?: number; text?: string; dataAttrs?: Record<string, string>; classes?: string[]; baseline?: Record<string, string>; after?: Record<string, string> }
  >,
): PageSnapshot {
  const els: PageSnapshot["elements"] = {};
  for (const [key, el] of Object.entries(elements)) {
    els[key] = {
      key,
      selector: el.selector,
      tag: "div",
      classes: el.classes ?? [],
      dataAttrs: el.dataAttrs ?? {},
      parentKey: "",
      childCount: el.childCount ?? 0,
      childSignature: [],
      text: el.text ?? "",
      position: { x: 0, y: 0, width: 0, height: 0 },
      baseline: el.baseline ?? null,
      after: el.after ?? null,
    };
  }
  return { version: 1, capturedAt: "", truncated: false, elements: els };
}

describe("diffPageStyles", () => {
  it("detects style changes across elements", () => {
    const baseline = makeSnapshot({
      a: { selector: "div.a", baseline: { color: "red" }, after: { color: "red" } },
      b: { selector: "div.b", baseline: { color: "blue" }, after: { color: "blue" } },
    });
    const after = makeSnapshot({
      a: { selector: "div.a", baseline: { color: "red" }, after: { color: "green" } },
      b: { selector: "div.b", baseline: { color: "blue" }, after: { color: "blue" } },
    });

    const result = diffPageStyles(baseline, after);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].prop).toBe("color");
    expect(result.changes[0].from).toBe("red");
    expect(result.changes[0].to).toBe("green");
  });

  it("detects added elements", () => {
    const baseline = makeSnapshot({});
    const after = makeSnapshot({
      a: { selector: "div.a", after: { color: "red" } },
    });

    const result = diffPageStyles(baseline, after);
    expect(result.added).toEqual(["a"]);
  });

  it("detects removed elements", () => {
    const baseline = makeSnapshot({
      a: { selector: "div.a", after: { color: "red" } },
    });
    const after = makeSnapshot({});

    const result = diffPageStyles(baseline, after);
    expect(result.removed).toEqual(["a"]);
  });
});

describe("summarizeStyleDiff", () => {
  it("groups changes by property and counts elements", () => {
    const changes = [
      { key: "a", selector: "div.a", prop: "color", from: "red", to: "blue" },
      { key: "b", selector: "div.b", prop: "color", from: "red", to: "blue" },
      { key: "a", selector: "div.a", prop: "margin", from: "0", to: "10px" },
    ];

    const result = summarizeStyleDiff(changes);
    expect(result.total).toBe(3);
    expect(result.elementCount).toBe(2);
    expect(result.topChanges[0].prop).toBe("color");
    expect(result.topChanges[0].elements).toBe(2);
  });
});

describe("queryStyleProperty", () => {
  it("filters changes to a specific property", () => {
    const changes = [
      { key: "a", selector: "div.a", prop: "overflow", from: "hidden", to: "auto" },
      { key: "b", selector: "div.b", prop: "color", from: "red", to: "blue" },
    ];
    const allElements: Record<string, { tag: string; childCount: number }> = {
      a: { tag: "div", childCount: 5 },
      b: { tag: "span", childCount: 0 },
    };

    const result = queryStyleProperty(changes, "overflow", allElements);
    expect(result.matches).toHaveLength(1);
    expect(result.prop).toBe("overflow");
    expect(result.matches[0].from).toBe("hidden");
    expect(result.matches[0].to).toBe("auto");
    expect(result.matches[0].isRelevant).toBe(true);
  });

  it("returns empty when property not found", () => {
    const changes = [
      { key: "a", selector: "div.a", prop: "color", from: "red", to: "blue" },
    ];

    const result = queryStyleProperty(changes, "overflow", {});
    expect(result.matches).toHaveLength(0);
  });
});

describe("queryChildChanges", () => {
  it("detects child count changes", () => {
    const baseline = makeSnapshot({
      a: { selector: "div.a", childCount: 10 },
    });
    const after = makeSnapshot({
      a: { selector: "div.a", childCount: 5 },
    });

    const result = queryChildChanges(baseline, after);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].details).toContain("children: 10 → 5");
  });

  it("ignores unchanged elements", () => {
    const baseline = makeSnapshot({
      a: { selector: "div.a", childCount: 5 },
    });
    const after = makeSnapshot({
      a: { selector: "div.a", childCount: 5 },
    });

    const result = queryChildChanges(baseline, after);
    expect(result.matches).toHaveLength(0);
  });
});

describe("queryTextChanges", () => {
  it("detects text content changes", () => {
    const baseline = makeSnapshot({
      a: { selector: "div.a", text: "Hello" },
    });
    const after = makeSnapshot({
      a: { selector: "div.a", text: "World" },
    });

    const result = queryTextChanges(baseline, after);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].details).toContain("Hello");
    expect(result.matches[0].details).toContain("World");
  });
});

describe("queryAttributeChanges", () => {
  it("detects data-attribute changes", () => {
    const baseline = makeSnapshot({
      a: { selector: "div.a", dataAttrs: { status: "todo" } },
    });
    const after = makeSnapshot({
      a: { selector: "div.a", dataAttrs: { status: "done" } },
    });

    const result = queryAttributeChanges(baseline, after);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].details).toContain("status");
    expect(result.matches[0].details).toContain("todo");
    expect(result.matches[0].details).toContain("done");
  });
});
