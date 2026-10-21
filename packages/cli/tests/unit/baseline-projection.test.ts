/**
 * Baseline projection contract — pinned to the real consumer reads.
 *
 * The projection keeps EXACTLY the union of fields verify + the query tools
 * read (see core/baseline-projection.ts for the per-field table). These specs
 * fail if a read field is dropped OR an unread field creeps in, and they prove
 * the non-vacuous core: the SAME page state validated from a projected
 * baseline and from the full baseline yields the SAME verdict.
 *
 * Fixtures are the real stored pair of task 883871d0
 * (tests/fixtures/baseline-element-883871d0.json raw, 4.5 KB;
 * tests/fixtures/baseline-page-883871d0.json.gz gunzipped at load, 280
 * elements, truncated:false, version:1) — not synthetic miniatures, so a
 * passing equivalence run means something about production-shaped data.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { computeDiff } from "../../src/core/diff.js";
import {
  diffPageStyles,
  queryChildChanges,
  queryTextChanges,
  queryAttributeChanges,
  queryStyleProperty,
} from "../../src/core/page-diff.js";
import {
  projectPageSnapshot,
  projectElementSnapshot,
  parseDomSnapshot,
  parsePageBaseline,
  parsePageAfterSnapshot,
  BaselineValidationError,
  PROJECTED_PAGE_ELEMENT_FIELDS,
  DROPPED_PAGE_ELEMENT_FIELDS,
  PROJECTED_ELEMENT_FIELDS,
} from "../../src/core/baseline-projection.js";
import type { DomSnapshot } from "../../src/core/verification-types.js";
import type { PageSnapshot } from "../../src/core/page-types.js";
import {
  parseElementBaseline,
  parsePageBaselineArtifact,
  verifyTask,
  VerifyError,
} from "../../src/commands/verify.js";
import { readEvidence } from "../../src/commands/verify-tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixtures(): { element: DomSnapshot; page: PageSnapshot } {
  const element = JSON.parse(
    readFileSync(
      join(HERE, "..", "fixtures", "baseline-element-883871d0.json"),
      "utf-8",
    ),
  ) as DomSnapshot;
  const page = JSON.parse(
    gunzipSync(
      readFileSync(
        join(HERE, "..", "fixtures", "baseline-page-883871d0.json.gz"),
      ),
    ).toString("utf-8"),
  ) as PageSnapshot;
  return { element, page };
}

const { element: REAL_ELEMENT, page: REAL_PAGE } = loadFixtures();
const REAL_PAGE_KEYS = Object.keys(REAL_PAGE.elements);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectMalformed(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BaselineValidationError);
    expect((err as BaselineValidationError).kind).toBe("malformed");
    return;
  }
  expect.unreachable("expected a BaselineValidationError");
}

// ── Page projection: exact field set ──────────────────────────────────────

describe("page projection keeps exactly the contracted fields", () => {
  it("projects every element of the real 280-element baseline to the exact key set", () => {
    const projected = projectPageSnapshot(REAL_PAGE);
    const expected = [...PROJECTED_PAGE_ELEMENT_FIELDS].sort();
    expect(REAL_PAGE_KEYS.length).toBeGreaterThan(100);
    for (const key of REAL_PAGE_KEYS) {
      expect(Object.keys(projected.elements[key]).sort()).toEqual(expected);
    }
  });

  it("drops baseline/parentKey/classes/key even though the input carries them", () => {
    const first = REAL_PAGE.elements[REAL_PAGE_KEYS[0]];
    expect(first.baseline).toBeDefined();
    expect(first.parentKey).toBeDefined();
    expect(first.classes).toBeDefined();
    expect(first.key).toBeDefined();
    const projected = projectPageSnapshot(REAL_PAGE).elements[REAL_PAGE_KEYS[0]];
    expect("baseline" in projected).toBe(false);
    expect("parentKey" in projected).toBe(false);
    expect("classes" in projected).toBe(false);
    expect("key" in projected).toBe(false);
  });

  it("documents every dropped field with a reason, and nothing else is dropped", () => {
    const fullKeys = new Set(Object.keys(REAL_PAGE.elements[REAL_PAGE_KEYS[0]]));
    const kept = new Set<string>(PROJECTED_PAGE_ELEMENT_FIELDS);
    const dropped = [...fullKeys].filter((k) => !kept.has(k));
    expect(dropped.sort()).toEqual(Object.keys(DROPPED_PAGE_ELEMENT_FIELDS).sort());
    for (const [field, reason] of Object.entries(DROPPED_PAGE_ELEMENT_FIELDS)) {
      expect(typeof reason).toBe("string");
      expect(reason.length).toBeGreaterThan(20);
      expect(field).toBeTruthy();
    }
  });

  it("preserves the structural envelope (version/capturedAt/truncated)", () => {
    const projected = projectPageSnapshot(REAL_PAGE);
    expect(projected.version).toBe(REAL_PAGE.version);
    expect(projected.capturedAt).toBe(REAL_PAGE.capturedAt);
    expect(projected.truncated).toBe(REAL_PAGE.truncated);
  });

  it("keeps every field each consumer reads — dropping one breaks its consumer", () => {
    // Consumer -> fields it dereferences (call sites in the module doc).
    // Asserted against the CONTRACT set (so the test fails at the definition)
    // and against real projection output (so it fails at the implementation).
    const consumerReads: Record<string, string[]> = {
      "verify.ts step-14 backfill": ["after"],
      "verify-tools.ts readEvidence backfill": ["after"],
      "diffPageStyles": ["after", "selector"],
      "style_query page-wide": ["after", "selector", "tag", "childCount"],
      "html_query children": ["childCount", "childSignature", "selector"],
      "html_query text": ["text", "selector"],
      "html_query attributes": ["dataAttrs", "selector"],
    };
    const contracted = new Set<string>(PROJECTED_PAGE_ELEMENT_FIELDS);
    const projected = projectPageSnapshot(REAL_PAGE).elements[REAL_PAGE_KEYS[0]];
    for (const [consumer, fields] of Object.entries(consumerReads)) {
      for (const field of fields) {
        expect(contracted.has(field), `${consumer} reads '${field}'`).toBe(true);
        expect(field in projected, `${consumer} reads '${field}'`).toBe(true);
      }
    }
  });
});

// ── Element projection: exact field set ───────────────────────────────────

describe("element projection keeps exactly the contracted fields", () => {
  it("projects the real element baseline to the exact key set", () => {
    const projected = projectElementSnapshot(REAL_ELEMENT);
    expect(Object.keys(projected).sort()).toEqual(
      [...PROJECTED_ELEMENT_FIELDS].sort(),
    );
  });

  it("keeps position sub-keys boundingBox/viewport/stackingContext, drops the rest", () => {
    expect(Object.keys(REAL_ELEMENT.position).sort()).toEqual(
      ["boundingBox", "scrollPosition", "stackingContext", "viewport"].sort(),
    );
    const projected = projectElementSnapshot(REAL_ELEMENT);
    expect(Object.keys(projected.position).sort()).toEqual(
      ["boundingBox", "stackingContext", "viewport"].sort(),
    );
    expect(projected.position.boundingBox).toEqual(
      REAL_ELEMENT.position.boundingBox,
    );
  });

  it("drops xpath/parentSnippet while keeping every computeDiff read", () => {
    expect(REAL_ELEMENT.xpath).toBeDefined();
    expect(REAL_ELEMENT.parentSnippet).toBeDefined();
    const projected = projectElementSnapshot(REAL_ELEMENT);
    expect("xpath" in projected).toBe(false);
    expect("parentSnippet" in projected).toBe(false);
    // computeDiff reads exactly these four — all survive.
    expect(projected.outerHTML).toBe(REAL_ELEMENT.outerHTML);
    expect(projected.computedStyles).toEqual(REAL_ELEMENT.computedStyles);
    expect(projected.consoleErrors).toEqual(REAL_ELEMENT.consoleErrors);
  });

  it("element_info reads (selector/position) survive on the element projection", () => {
    const projected = projectElementSnapshot(REAL_ELEMENT);
    expect(projected.selector).toBe(REAL_ELEMENT.selector);
    expect(projected.position).toBeDefined();
  });
});

// ── Equivalence: same verdict from projected and full baselines ───────────

function syntheticElementAfters(full: DomSnapshot): Array<[string, DomSnapshot]> {
  const snaps: Array<[string, DomSnapshot]> = [];
  snaps.push(["no-change", clone(full)]);
  snaps.push([
    "html-changed",
    { ...clone(full), outerHTML: `${full.outerHTML}<!-- changed -->` },
  ]);
  {
    const a = clone(full);
    const firstKey = Object.keys(a.computedStyles)[0];
    a.computedStyles[firstKey] = "CHANGED-SENTINEL";
    snaps.push(["style-changed", a]);
  }
  {
    const a = clone(full);
    a.position.boundingBox.x += 50;
    snaps.push(["position-shifted", a]);
  }
  {
    const a = clone(full);
    a.consoleErrors = [...a.consoleErrors, "boom-sentinel"];
    snaps.push(["new-console-error", a]);
  }
  snaps.push(["selector-missing", { ...clone(full), outerHTML: "" }]);
  return snaps;
}

describe("equivalence: projected element baseline validates identically", () => {
  it("real computeDiff(full, after) deep-equals computeDiff(projected, after) across six states", () => {
    const projected = projectElementSnapshot(REAL_ELEMENT);
    const cases: string[] = [];
    for (const [name, after] of syntheticElementAfters(REAL_ELEMENT)) {
      const fromFull = computeDiff(REAL_ELEMENT, after);
      const fromProjected = computeDiff(projected, after);
      expect(fromProjected, `divergence on '${name}'`).toEqual(fromFull);
      cases.push(name);
    }
    expect(cases).toHaveLength(6);
  });
});

/** A changed page state derived from the real baseline (not a miniature). */
function mutatedPageState(): PageSnapshot {
  const after = clone(REAL_PAGE);
  const [styleKey, textKey, childKey, attrKey] = REAL_PAGE_KEYS;
  const styleProp = Object.keys(after.elements[styleKey].after ?? {})[0];
  (after.elements[styleKey].after as Record<string, string>)[styleProp] =
    "CHANGED-SENTINEL";
  after.elements[textKey].text = `${after.elements[textKey].text} (changed)`;
  after.elements[childKey].childCount += 1;
  after.elements[childKey].childSignature = [
    ...after.elements[childKey].childSignature,
    "span.sentinel ×1",
  ];
  after.elements[attrKey].dataAttrs = {
    ...after.elements[attrKey].dataAttrs,
    sentinel: "1",
  };
  // One removal and one addition: added/removed agreement is part of the verdict.
  delete after.elements[REAL_PAGE_KEYS[REAL_PAGE_KEYS.length - 1]];
  after.elements["sentinel/added"] = {
    ...clone(after.elements[styleKey]),
    key: "sentinel/added",
    selector: "div.sentinel",
  };
  return after;
}

describe("equivalence: projected page baseline validates identically", () => {
  it("page-diff queries agree on full vs projected baselines for the same page state", () => {
    const after = mutatedPageState();
    const full = REAL_PAGE;
    const projected = projectPageSnapshot(REAL_PAGE);

    expect(diffPageStyles(projected, after)).toEqual(diffPageStyles(full, after));
    expect(queryChildChanges(projected, after)).toEqual(
      queryChildChanges(full, after),
    );
    expect(queryTextChanges(projected, after)).toEqual(
      queryTextChanges(full, after),
    );
    expect(queryAttributeChanges(projected, after)).toEqual(
      queryAttributeChanges(full, after),
    );
  });

  it("style_query derivation agrees: same changes, same matches", () => {
    const after = mutatedPageState();
    const fullChanges = diffPageStyles(REAL_PAGE, after).changes;
    const projChanges = diffPageStyles(
      projectPageSnapshot(REAL_PAGE),
      after,
    ).changes;
    expect(projChanges).toEqual(fullChanges);
    expect(fullChanges.length).toBeGreaterThan(0);
    const prop = fullChanges[0].prop;
    expect(
      queryStyleProperty(projChanges, prop, after.elements),
    ).toEqual(queryStyleProperty(fullChanges, prop, after.elements));
  });

  it("verify backfill inputs agree: same keys resolve an .after map on both sides", () => {
    const after = mutatedPageState();
    const keysWithAfter = (baseline: {
      elements: Record<string, { after: unknown }>;
    }): string[] =>
      Object.keys(after.elements).filter(
        (key) => baseline.elements[key]?.after != null,
      );
    expect(keysWithAfter(projectPageSnapshot(REAL_PAGE))).toEqual(
      keysWithAfter(REAL_PAGE),
    );
  });
});

// ── Tolerance: projected parses, malformed throws ─────────────────────────

describe("verify tolerates projected baselines", () => {
  it("parses the projected element baseline", () => {
    expect(() =>
      parseDomSnapshot(
        projectElementSnapshot(REAL_ELEMENT),
        "projected element",
      ),
    ).not.toThrow();
  });

  it("parses the projected 280-element page baseline (droppables absent by design)", () => {
    const projected = projectPageSnapshot(REAL_PAGE);
    expect("baseline" in projected.elements[REAL_PAGE_KEYS[0]]).toBe(false);
    expect(() => parsePageBaseline(projected, "projected page")).not.toThrow();
  });
});

describe("malformed element baselines throw instead of degrading", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["array", []],
    ["empty object", {}],
    ["outerHTML not a string", { ...clone(REAL_ELEMENT), outerHTML: 42 }],
    ["computedStyles not an object", { ...clone(REAL_ELEMENT), computedStyles: "x" }],
    ["selector missing", (() => { const c = clone(REAL_ELEMENT); delete (c as Record<string, unknown>).selector; return c; })()],
    ["position missing", (() => { const c = clone(REAL_ELEMENT); delete (c as Record<string, unknown>).position; return c; })()],
    ["boundingBox.x not a number", (() => { const c = clone(REAL_ELEMENT); (c.position.boundingBox as Record<string, unknown>).x = "far"; return c; })()],
    ["viewport missing", (() => { const c = clone(REAL_ELEMENT); delete (c.position as Record<string, unknown>).viewport; return c; })()],
    ["stackingContext missing", (() => { const c = clone(REAL_ELEMENT); delete (c.position as Record<string, unknown>).stackingContext; return c; })()],
    ["browser missing", (() => { const c = clone(REAL_ELEMENT); delete (c as Record<string, unknown>).browser; return c; })()],
    ["consoleErrors not an array", { ...clone(REAL_ELEMENT), consoleErrors: {} }],
    ["capturedAt missing", (() => { const c = clone(REAL_ELEMENT); delete (c as Record<string, unknown>).capturedAt; return c; })()],
  ];
  for (const [name, raw] of cases) {
    it(`throws on ${name}`, () => {
      expectMalformed(() => parseDomSnapshot(raw, "case"));
    });
  }
});

describe("malformed page baselines throw instead of degrading", () => {
  const validElement = (): Record<string, unknown> =>
    clone(REAL_PAGE.elements[REAL_PAGE_KEYS[0]]) as unknown as Record<string, unknown>;
  const validPage = (): Record<string, unknown> =>
    clone(REAL_PAGE) as unknown as Record<string, unknown>;

  it("throws on envelope failures", () => {
    expectMalformed(() => parsePageBaseline(null, "case"));
    expectMalformed(() => parsePageBaseline([], "case"));
    expectMalformed(() => parsePageBaseline({}, "case"));
    expectMalformed(() =>
      parsePageBaseline({ ...validPage(), version: 2 }, "case"),
    );
    expectMalformed(() =>
      parsePageBaseline({ ...validPage(), elements: [] }, "case"),
    );
    expectMalformed(() =>
      parsePageBaseline({ ...validPage(), truncated: "no" }, "case"),
    );
  });

  it("throws on a truncated baseline instead of comparing a subset", () => {
    try {
      parsePageBaseline({ ...validPage(), truncated: true }, "case");
    } catch (err) {
      expect(err).toBeInstanceOf(BaselineValidationError);
      expect((err as BaselineValidationError).kind).toBe("truncated");
      return;
    }
    expect.unreachable("expected a truncated BaselineValidationError");
  });

  it("throws on per-element failures", () => {
    const withElement = (mutate: (el: Record<string, unknown>) => void) => {
      const page = validPage();
      const elements = page.elements as Record<string, Record<string, unknown>>;
      mutate(elements[REAL_PAGE_KEYS[0]]);
      return page;
    };
    expectMalformed(() => parsePageBaseline(withElement((el) => { delete el.after; }), "case"));
    expectMalformed(() => parsePageBaseline(withElement((el) => { el.after = null; }), "case"));
    expectMalformed(() => parsePageBaseline(withElement((el) => { delete el.selector; }), "case"));
    expectMalformed(() => parsePageBaseline(withElement((el) => { delete el.tag; }), "case"));
    expectMalformed(() => parsePageBaseline(withElement((el) => { el.childCount = "many"; }), "case"));
    expectMalformed(() => parsePageBaseline(withElement((el) => { delete el.childSignature; }), "case"));
    expectMalformed(() => parsePageBaseline(withElement((el) => { delete el.text; }), "case"));
    expectMalformed(() => parsePageBaseline(withElement((el) => { delete el.dataAttrs; }), "case"));
    expectMalformed(() => parsePageBaseline(withElement((el) => { delete el.position; }), "case"));
    // Droppables absent is FINE — this is the tolerance half of the contract.
    expect(() =>
      parsePageBaseline(
        withElement((el) => {
          delete el.baseline;
          delete el.parentKey;
          delete el.classes;
          delete el.key;
        }),
        "case",
      ),
    ).not.toThrow();
  });

  it("parsePageAfterSnapshot allows a truncated after-capture but still rejects shape failures", () => {
    const truncated = { ...validPage(), truncated: true };
    expect(() => parsePageAfterSnapshot(truncated, "case")).not.toThrow();
    expectMalformed(() => parsePageAfterSnapshot({ ...validPage(), version: 2 }, "case"));
    expectMalformed(() =>
      parsePageAfterSnapshot(
        (() => {
          const page = validPage();
          const elements = page.elements as Record<string, Record<string, unknown>>;
          delete elements[REAL_PAGE_KEYS[0]].selector;
          return page;
        })(),
        "case",
      ),
    );
  });
});

// ── Wiring: CLI surfaces map validation failures to hard errors ───────────

describe("verify maps validation failures to E_BASELINE_* VerifyErrors", () => {
  it("parseElementBaseline maps malformed to E_BASELINE_MALFORMED", () => {
    try {
      parseElementBaseline({ outerHTML: 42 }, "t", "case");
    } catch (err) {
      expect(err).toBeInstanceOf(VerifyError);
      expect((err as VerifyError).code).toBe("E_BASELINE_MALFORMED");
      expect((err as VerifyError).suggestion).toBeTruthy();
      return;
    }
    expect.unreachable("expected E_BASELINE_MALFORMED");
  });

  it("parsePageBaselineArtifact maps malformed/truncated to E_BASELINE_MALFORMED/E_BASELINE_TRUNCATED", () => {
    try {
      parsePageBaselineArtifact({ version: 2 }, "t", "case");
      expect.unreachable("expected E_BASELINE_MALFORMED");
    } catch (err) {
      expect(err).toBeInstanceOf(VerifyError);
      expect((err as VerifyError).code).toBe("E_BASELINE_MALFORMED");
    }
    try {
      parsePageBaselineArtifact(
        { ...clone(REAL_PAGE), truncated: true },
        "t",
        "case",
      );
      expect.unreachable("expected E_BASELINE_TRUNCATED");
    } catch (err) {
      expect(err).toBeInstanceOf(VerifyError);
      expect((err as VerifyError).code).toBe("E_BASELINE_TRUNCATED");
      expect((err as VerifyError).suggestion).toBeTruthy();
    }
  });

  it("verifyTask rejects a malformed stored element baseline before touching the browser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proj-verify-"));
    try {
      const taskId = "malformed-baseline-task";
      mkdirSync(join(dir, ".vibeflow", "tasks", "2026-10-11"), { recursive: true });
      mkdirSync(join(dir, ".vibeflow", "tasks", "files", taskId), { recursive: true });
      writeFileSync(
        join(dir, ".vibeflow", "tasks", "2026-10-11", `${taskId}.json`),
        JSON.stringify({ id: taskId, title: "t", status: "todo", created: "2026-10-11T00:00:00Z" }),
      );
      writeFileSync(
        join(dir, ".vibeflow", "tasks", "files", taskId, "baseline-element.json"),
        JSON.stringify({ outerHTML: 42 }),
      );
      await expect(verifyTask(dir, taskId)).rejects.toMatchObject({
        code: "E_BASELINE_MALFORMED",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifyTask tolerates a projected element baseline past validation (fails later on E_NO_URL, not on shape)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proj-verify-"));
    try {
      const taskId = "projected-baseline-task";
      mkdirSync(join(dir, ".vibeflow", "tasks", "2026-10-11"), { recursive: true });
      mkdirSync(join(dir, ".vibeflow", "tasks", "files", taskId), { recursive: true });
      writeFileSync(
        join(dir, ".vibeflow", "tasks", "2026-10-11", `${taskId}.json`),
        JSON.stringify({ id: taskId, title: "t", status: "todo", created: "2026-10-11T00:00:00Z" }),
      );
      writeFileSync(
        join(dir, ".vibeflow", "tasks", "files", taskId, "baseline-element.json"),
        JSON.stringify(projectElementSnapshot(REAL_ELEMENT)),
      );
      // No URL on the task: validation passes, the run proceeds to E_NO_URL.
      await expect(verifyTask(dir, taskId)).rejects.toMatchObject({
        code: "E_NO_URL",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readEvidence fails loudly on malformed baselines, tolerates absence", () => {
  function writeFiles(taskId: string, files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "proj-evidence-"));
    const filesDir = join(dir, ".vibeflow", "tasks", "files", taskId);
    mkdirSync(filesDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(filesDir, name), content);
    }
    return dir;
  }

  it("returns nulls when no evidence files exist yet", async () => {
    const dir = writeFiles("empty-task", {});
    try {
      const ev = await readEvidence(dir, "empty-task");
      expect(ev.baseline).toBeNull();
      expect(ev.after).toBeNull();
      expect(ev.allStyles).toBeNull();
      expect(ev.pageBaseline).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a malformed baseline-page.json instead of returning nulls", async () => {
    const dir = writeFiles("bad-page-task", {
      "baseline-page.json": JSON.stringify({ version: 1 }),
    });
    try {
      await expect(readEvidence(dir, "bad-page-task")).rejects.toBeInstanceOf(
        BaselineValidationError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a truncated baseline-page.json", async () => {
    const dir = writeFiles("truncated-page-task", {
      "baseline-page.json": JSON.stringify({
        ...clone(REAL_PAGE),
        truncated: true,
      }),
    });
    try {
      await expect(
        readEvidence(dir, "truncated-page-task"),
      ).rejects.toMatchObject({ kind: "truncated" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts projected baselines and back-fills element.baseline from .after", async () => {
    const projected = projectPageSnapshot(REAL_PAGE);
    const afterCapture = clone(REAL_PAGE);
    for (const el of Object.values(afterCapture.elements)) {
      delete (el as Record<string, unknown>).baseline;
    }
    const dir = writeFiles("projected-task", {
      "baseline-page.json": JSON.stringify(projected),
      "verify-all-styles.json": JSON.stringify(afterCapture),
      "baseline.json": JSON.stringify(REAL_ELEMENT),
      "verify-after.json": JSON.stringify(clone(REAL_ELEMENT)),
      "verify-diff.json": JSON.stringify({ stylesChanged: {} }),
      "verify-console.txt": "(no console errors)",
    });
    try {
      const ev = await readEvidence(dir, "projected-task");
      expect(ev.baseline).not.toBeNull();
      expect(ev.after).not.toBeNull();
      const allStyles = ev.allStyles as unknown as PageSnapshot;
      const first = allStyles.elements[REAL_PAGE_KEYS[0]];
      expect(first.baseline).toEqual(projected.elements[REAL_PAGE_KEYS[0]].after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
