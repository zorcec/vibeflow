// @vitest-environment jsdom
/**
 * Regression: page-capture truncation must reach the agent.
 *
 * `capturePageWideElements` caps the page-wide snapshot at `maxElements` and
 * records `truncated: true` on the snapshot. That flag used to be discarded —
 * the style summary hardcoded `truncated: false` and nothing surfaced it — so a
 * page larger than the cap produced a silent subset diff while the agent was
 * told nothing had been skipped. That is a false negative: the worst failure
 * mode for a verification tool, because it is invisible.
 *
 * This spec fails on the pre-fix code: `MAX_ELEMENTS`,
 * `captureTruncationWarning` and `printResult` were not exported, and
 * `summarizeStyleDiff` ignored the snapshot's truncation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  capturePageWideElements,
  captureTruncationWarning,
  MAX_ELEMENTS,
  printResult,
  type VerifyResult,
} from "../../src/commands/verify.js";
import {
  summarizeStyleDiff,
  queryChildChanges,
  queryTextChanges,
  queryAttributeChanges,
} from "../../src/core/page-diff.js";
import type { PageSnapshot } from "../../src/core/page-types.js";

type CaptureInput = { styles: string[]; maxElements: number };

// The callback runs unmodified here — self-containment across the Playwright
// serialization boundary is covered by page-wide-capture.test.ts. Calling it
// directly keeps this spec runnable under Stryker, which instruments the source
// and would make a re-serialized `new Function(toString())` throw.
function capture(input: CaptureInput) {
  return capturePageWideElements(input);
}

function makeSnapshot(
  truncated: boolean,
  elements: Record<string, { selector: string; childCount?: number }>,
): PageSnapshot {
  const els: PageSnapshot["elements"] = {};
  for (const [key, el] of Object.entries(elements)) {
    els[key] = {
      key,
      selector: el.selector,
      tag: "div",
      classes: [],
      dataAttrs: {},
      parentKey: "",
      childCount: el.childCount ?? 0,
      childSignature: [],
      text: "",
      position: { x: 0, y: 0, width: 0, height: 0 },
      baseline: null,
      after: null,
    };
  }
  return { version: 1, capturedAt: "", truncated, elements: els };
}

/** Minimal result good enough for the human-readable printer. */
function makeVerifyResult(captureTruncated: boolean): VerifyResult {
  return {
    taskId: "abc123",
    ok: true,
    taskDescription: "synthetic page",
    baseline: { selector: "div", url: "", capturedAt: "" },
    after: { snapshot: {}, consoleErrors: [] },
    diff: {
      selectorResolves: true,
      htmlChanged: false,
      stylesChanged: {},
      positionChanged: false,
      newConsoleErrors: [],
    },
    evidenceFiles: [],
    verdict: "no changes",
    captureTruncated,
  } as unknown as VerifyResult;
}

describe("capture truncation is surfaced to the agent", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build a page whose capture exceeds MAX_ELEMENTS.
   *
   * Grouped rather than flat on purpose: the capture builds a DOM-path key per
   * element via `Array.from(parent.children).indexOf(...)`, so a flat sibling
   * list is O(n²) and 1000 siblings take ~45s in jsdom. Nesting in groups keeps
   * the same element count while staying linear enough to run in the suite.
   */
  function buildOversizedPage(groups: number, perGroup: number): number {
    for (let g = 0; g < groups; g++) {
      const group = document.createElement("div");
      group.className = "group";
      group.setAttribute("data-group-id", String(g));
      for (let i = 0; i < perGroup; i++) {
        const item = document.createElement("div");
        item.className = "item";
        item.setAttribute("data-task-id", `t${g}-${i}`);
        item.textContent = "x";
        group.appendChild(item);
      }
      document.body.appendChild(group);
    }
    return groups * (perGroup + 1);
  }

  it("reports truncated:true and the warning for a page larger than MAX_ELEMENTS", () => {
    const matched = buildOversizedPage(40, 40); // 1640 accepted elements
    expect(matched).toBeGreaterThan(MAX_ELEMENTS);

    const snapshot = capture({ styles: ["color"], maxElements: MAX_ELEMENTS });

    expect(snapshot.truncated).toBe(true);
    expect(Object.keys(snapshot.elements)).toHaveLength(MAX_ELEMENTS);

    const warning = captureTruncationWarning(MAX_ELEMENTS);
    expect(warning).toContain("truncated");
    expect(warning).toContain(String(MAX_ELEMENTS));
    expect(warning).toContain("NOT compared");
  });

  it("propagates the snapshot's truncated flag through summarizeStyleDiff", () => {
    const changes = [
      { key: "a", selector: "div.a", prop: "color", from: "red", to: "blue" },
    ];
    expect(summarizeStyleDiff(changes, false).truncated).toBe(false);
    expect(summarizeStyleDiff(changes, true).truncated).toBe(true);
  });

  it("propagates truncation through every structure diff", () => {
    const capped = makeSnapshot(true, {
      a: { selector: "div.a", childCount: 5 },
    });
    const full = makeSnapshot(false, {
      a: { selector: "div.a", childCount: 5 },
    });

    // A cap on EITHER snapshot yields a partial comparison.
    expect(queryChildChanges(full, capped).truncated).toBe(true);
    expect(queryChildChanges(capped, full).truncated).toBe(true);
    expect(queryTextChanges(full, capped).truncated).toBe(true);
    expect(queryTextChanges(capped, full).truncated).toBe(true);
    expect(queryAttributeChanges(full, capped).truncated).toBe(true);
    expect(queryAttributeChanges(capped, full).truncated).toBe(true);

    // Two complete snapshots compare fully.
    expect(queryChildChanges(full, full).truncated).toBe(false);
    expect(queryTextChanges(full, full).truncated).toBe(false);
    expect(queryAttributeChanges(full, full).truncated).toBe(false);
  });

  it("prints the truncation warning in the verify output", () => {
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
    try {
      printResult(makeVerifyResult(true));
    } finally {
      spy.mockRestore();
    }

    expect(logs.join("\n")).toContain("truncated");
    expect(logs.join("\n")).toContain(String(MAX_ELEMENTS));
  });
});
