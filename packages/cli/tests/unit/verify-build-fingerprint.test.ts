// @vitest-environment jsdom
/**
 * Served-build fingerprint — the stale-board blind spot.
 *
 * The incident this covers: `vibeflow verify` returned clean/green evidence
 * against a board that was still serving a bundle built BEFORE the change under
 * test. The page was real and the selectors resolved, so nothing in the output
 * said the measured code was not the code in the working tree.
 *
 * The fix is evidence, not a verdict: every run records WHICH build it measured
 * (hash + version stamp), prints it next to the evidence paths, stores it in the
 * evidence JSON, and warns LOUDLY when the baseline evidence and the current run
 * measured two different builds — a rebuild in between means the diff compares
 * two different builds and "unchanged" proves nothing.
 *
 * The mismatch path is exercised for real here: the served bundle's text is
 * changed between two verify runs (exactly what a rebuild does to the board's
 * inlined assets), not simulated by asserting on a hand-built warning string.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Playwright mock: the "served page" is the jsdom document ────────────────
const mockElement = {
  evaluate: vi.fn().mockResolvedValue('<div class="probe">probe</div>'),
  boundingBox: vi
    .fn()
    .mockResolvedValue({ x: 10, y: 20, width: 40, height: 30 }),
};

const fakeWindow = {
  scrollX: 0,
  scrollY: 0,
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  localStorage: { setItem: vi.fn() },
  sessionStorage: { setItem: vi.fn() },
};

const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  waitForSelector: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  content: vi.fn().mockResolvedValue("<html><body><div class=\"probe\">probe</div></body></html>"),
  locator: vi.fn(() => ({
    first: vi.fn(() => mockElement),
    count: vi.fn().mockResolvedValue(1),
  })),
  evaluate: vi.fn(async (fn: unknown) => {
    if (fn === collectServedAssetInputs) return collectServedAssetInputs();
    if (typeof fn === "function") return (fn as (w: unknown) => unknown)(fakeWindow);
    return {};
  }),
};

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  addCookies: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("playwright", () => ({
  chromium: { launch: vi.fn().mockResolvedValue(mockBrowser) },
}));

// ── Imports after the mock ─────────────────────────────────────────────────
import { createTask } from "../../src/core/tasks.js";
import { PROTO_DIR, FILES_DIR, type Task } from "../../src/core/types.js";
import {
  collectServedAssetInputs,
  buildServedBuildFingerprint,
  compareServedBuilds,
  servedBuildReport,
  servedBuildMismatchWarning,
  captureServedBuildFingerprint,
  printResult,
  verifyTask,
  UNKNOWN_BUILD,
  type ServedBuildFingerprint,
  type VerifyResult,
} from "../../src/commands/verify.js";

// ── The served board ───────────────────────────────────────────────────────
const BOARD_CSS = ":root{--p-bg:#020c1b}";
const BOARD_VERSION = "0.19.3";

/** Wire the jsdom document up as the board's served shell. */
function serveBoard(bundleText: string, version = BOARD_VERSION): void {
  document.head.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = BOARD_CSS;
  document.head.appendChild(style);
  const config = document.createElement("script");
  config.textContent = `window.__PORT__ = 3700; window.__CLI_VERSION__ = ${JSON.stringify(version)};`;
  document.head.appendChild(config);
  const bundle = document.createElement("script");
  bundle.textContent = bundleText;
  document.head.appendChild(bundle);
  (window as unknown as Record<string, unknown>).__CLI_VERSION__ = version;
}

const BUILD_A = "(function(){var a=1;return a})();";
const BUILD_B = "(function(){var a=1;var b=2;return a+b})();";

// sha256 of the inlined assets — computed here, not imported, so the test can
// state the fingerprint independently of the implementation's hashing order.
function fingerprintOf(bundleText: string, version = BOARD_VERSION): string {
  const inputs = {
    assetUrls: [] as string[],
    inlineAssets: [BOARD_CSS, bundleText],
    version,
  };
  return inputs.inlineAssets.length + inputs.assetUrls.length > 0
    ? JSON.stringify({
        assetUrls: inputs.assetUrls,
        inlineAssets: inputs.inlineAssets,
      })
    : "";
}

function makeBaseline(): Task["baseline"] {
  return {
    outerHTML: '<div class="probe">probe</div>',
    computedStyles: { color: "rgb(0, 0, 0)" },
    selector: ".probe",
    position: {
      boundingBox: { x: 10, y: 20, width: 40, height: 30 },
      scrollPosition: { x: 0, y: 0 },
      viewport: { width: 1280, height: 720, dpr: 1 },
      stackingContext: { zIndex: "auto", position: "static" },
    },
    browser: "Mozilla/5.0",
    consoleErrors: [],
    capturedAt: "2026-10-10T09:00:00.000Z",
  };
}

function makeResult(overrides: {
  servedBuild?: ServedBuildFingerprint | null;
  baselineBuild?: ServedBuildFingerprint | null;
  buildComparison?: VerifyResult["buildComparison"];
}): VerifyResult {
  const after = overrides.servedBuild ?? null;
  const baseline = overrides.baselineBuild ?? null;
  return {
    taskId: "abc123",
    ok: true,
    taskDescription: "synthetic",
    baseline: { selector: ".probe", url: "", capturedAt: "" },
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
    captureTruncated: false,
    servedBuild: after ?? {
      hash: UNKNOWN_BUILD,
      version: UNKNOWN_BUILD,
      assetUrls: [],
      source: "none",
      capturedAt: "",
    },
    baselineBuild: baseline,
    buildComparison: overrides.buildComparison ?? compareServedBuilds(baseline, after),
  } as unknown as VerifyResult;
}

function loggedOutput(fn: () => void): string {
  const logs: string[] = [];
  const spy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return logs.join("\n");
}

// ── 1. What the served board exposes ───────────────────────────────────────
describe("collectServedAssetInputs — what the served page reveals", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    delete (window as unknown as Record<string, unknown>).__CLI_VERSION__;
    delete (window as unknown as Record<string, unknown>).__NEXT_DATA__;
    delete (window as unknown as Record<string, unknown>).__BUILD_ID__;
  });

  it("reads the inlined bundle + CSS and the shell's version stamp", () => {
    serveBoard(BUILD_A);

    const inputs = collectServedAssetInputs();

    expect(inputs.version).toBe(BOARD_VERSION);
    expect(inputs.assetUrls).toEqual([]);
    expect(inputs.inlineAssets).toEqual([BOARD_CSS, BUILD_A]);
  });

  it("excludes the shell's runtime config script (port/user change per request)", () => {
    serveBoard(BUILD_A);
    const config = document.querySelector("script");
    expect(config?.textContent).toContain("window.__PORT__");

    const inputs = collectServedAssetInputs();

    // The port is in the served HTML, so hashing every inline script would
    // report a "rebuild" every time the board moved ports.
    expect(inputs.inlineAssets).not.toContain(config?.textContent);
    expect(inputs.inlineAssets.join("")).toContain(BUILD_A);
  });

  it("collects content-hashed asset URLs for an app that serves them", () => {
    document.head.innerHTML = `
      <script src="/_next/static/chunks/main-1a2b3c.js"></script>
      <link rel="stylesheet" href="/_next/static/css/9f8e7d.css">
    `;
    (window as unknown as Record<string, unknown>).__NEXT_DATA__ = {
      buildId: "build-7d6f5e",
    };

    const inputs = collectServedAssetInputs();

    expect(inputs.version).toBe("build-7d6f5e");
    expect(inputs.assetUrls).toEqual([
      "/_next/static/chunks/main-1a2b3c.js",
      "/_next/static/css/9f8e7d.css",
    ]);
  });

  it("degrades to nothing when the page exposes no build identity", () => {
    document.head.innerHTML = "";
    delete (window as unknown as Record<string, unknown>).__CLI_VERSION__;

    const inputs = collectServedAssetInputs();

    expect(inputs).toEqual({
      version: UNKNOWN_BUILD,
      assetUrls: [],
      inlineAssets: [],
    });
  });

  it("is safe to serialise into the page — it closes over no module scope", () => {
    // REGRESSION TEST for a shipped-broken fingerprint. `page.evaluate` ships
    // this function's SOURCE into the browser, so it cannot reference module
    // scope: a module constant is undefined in the page and throws. The throw
    // was swallowed by captureServedBuildFingerprint's catch, so every REAL
    // verify run reported "cannot compare builds" while these tests stayed
    // green — they call the function directly in Node, where the module
    // constant IS in scope.
    //
    // BOTH branches are exercised on purpose: the no-identity branch is the one
    // that reaches the module-scope fallback. Asserting only the happy path
    // makes this test vacuous — verified by reintroducing the bug and watching
    // it still pass.
    const isolate = () =>
      new Function(
        `return (${collectServedAssetInputs.toString()})`,
      )() as () => {
        version: string;
        assetUrls: string[];
        inlineAssets: string[];
      };

    // (a) a served board: it must still read the page from no-closure scope
    serveBoard(BUILD_A);
    const readsBoard = isolate();
    expect(() => readsBoard()).not.toThrow();
    expect(readsBoard().inlineAssets).toEqual([BOARD_CSS, BUILD_A]);
    expect(readsBoard().version).toBe(BOARD_VERSION);

    // (b) a page with no identity: this reaches the module-scope fallback
    document.head.innerHTML = "";
    for (const key of ["__CLI_VERSION__", "__NEXT_DATA__", "__BUILD_ID__"]) {
      delete (window as unknown as Record<string, unknown>)[key];
    }
    const readsNothing = isolate();
    expect(() => readsNothing()).not.toThrow();
    expect(readsNothing()).toEqual({
      version: "unknown",
      assetUrls: [],
      inlineAssets: [],
    });
  });
});

// ── 2. The fingerprint itself ──────────────────────────────────────────────
describe("buildServedBuildFingerprint", () => {
  const hash = (t: string) => `sha256:${t.length}:${t.slice(0, 8)}`;

  it("hashes the inlined assets and records which input it used", () => {
    const fp = buildServedBuildFingerprint(
      { version: BOARD_VERSION, assetUrls: [], inlineAssets: [BOARD_CSS, BUILD_A] },
      hash,
    );

    expect(fp.hash).toBe(hash(fingerprintOf(BUILD_A)));
    expect(fp.source).toBe("inline-assets");
    expect(fp.version).toBe(BOARD_VERSION);
  });

  it("changes when the served bundle changes (a rebuild)", () => {
    const a = buildServedBuildFingerprint(
      { version: BOARD_VERSION, assetUrls: [], inlineAssets: [BOARD_CSS, BUILD_A] },
      hash,
    );
    const b = buildServedBuildFingerprint(
      { version: BOARD_VERSION, assetUrls: [], inlineAssets: [BOARD_CSS, BUILD_B] },
      hash,
    );

    expect(a.hash).not.toBe(b.hash);
  });

  it("is stable for the same served assets", () => {
    const inputs = { version: BOARD_VERSION, assetUrls: [], inlineAssets: [BOARD_CSS, BUILD_A] };
    expect(buildServedBuildFingerprint(inputs, hash).hash).toBe(
      buildServedBuildFingerprint(inputs, hash).hash,
    );
  });

  it("ignores the board's port — only asset content and URLs are hashed", () => {
    // The runtime config script is filtered at collection time, so moving the
    // board to another port must not look like a rebuild.
    serveBoard(BUILD_A);
    const first = buildServedBuildFingerprint(collectServedAssetInputs(), hash);
    serveBoard(BUILD_A, BOARD_VERSION);
    expect(buildServedBuildFingerprint(collectServedAssetInputs(), hash).hash).toBe(
      first.hash,
    );
  });

  it("reports 'unknown' rather than inventing a fingerprint", () => {
    const fp = buildServedBuildFingerprint(
      { version: UNKNOWN_BUILD, assetUrls: [], inlineAssets: [] },
      hash,
    );

    expect(fp.hash).toBe(UNKNOWN_BUILD);
    expect(fp.source).toBe("none");
  });
});

// ── 3. Comparison + the loud warning ───────────────────────────────────────
describe("compareServedBuilds", () => {
  const hash = (t: string) => `h:${t.length}`;
  const build = (bundle: string, version = BOARD_VERSION) =>
    buildServedBuildFingerprint(
      { version, assetUrls: [], inlineAssets: [BOARD_CSS, bundle] },
      hash,
    );

  it("matches the same build", () => {
    expect(compareServedBuilds(build(BUILD_A), build(BUILD_A))).toBe("match");
  });

  it("mismatches a rebuild between the two measurements", () => {
    expect(compareServedBuilds(build(BUILD_A), build(BUILD_B))).toBe("mismatch");
  });

  it("has nothing to compare on the first run", () => {
    expect(compareServedBuilds(null, build(BUILD_A))).toBe("no-reference");
  });

  it("reports 'unknown', not 'no-reference', when this run is the blind side", () => {
    const unknown = buildServedBuildFingerprint(
      { version: UNKNOWN_BUILD, assetUrls: [], inlineAssets: [] },
      hash,
    );
    // A run whose own page exposes no build identity is blind regardless of
    // whether a reference exists — it must never read as "nothing to compare".
    expect(compareServedBuilds(null, unknown)).toBe("unknown");
    expect(compareServedBuilds(build(BUILD_A), unknown)).toBe("unknown");
  });

  it("has nothing to compare when the recorded reference is unmeasurable", () => {
    const unknown = buildServedBuildFingerprint(
      { version: UNKNOWN_BUILD, assetUrls: [], inlineAssets: [] },
      hash,
    );
    expect(compareServedBuilds(unknown, build(BUILD_A))).toBe("no-reference");
  });

  it("never reports 'match' when a side is unmeasurable", () => {
    const unknown = buildServedBuildFingerprint(
      { version: UNKNOWN_BUILD, assetUrls: [], inlineAssets: [] },
      hash,
    );
    for (const pair of [
      [unknown, build(BUILD_A)],
      [build(BUILD_A), unknown],
      [null, unknown],
      [unknown, null],
    ] as const) {
      expect(compareServedBuilds(pair[0], pair[1])).not.toBe("match");
    }
  });
});

describe("the mismatch warning", () => {
  const hash = (t: string) => `h:${t.length}`;
  const baseline = buildServedBuildFingerprint(
    { version: "0.19.2", assetUrls: [], inlineAssets: [BOARD_CSS, BUILD_A] },
    hash,
  );
  const after = buildServedBuildFingerprint(
    { version: "0.19.3", assetUrls: [], inlineAssets: [BOARD_CSS, BUILD_B] },
    hash,
  );

  it("names both fingerprints and states what the warning does NOT mean", () => {
    const warning = servedBuildMismatchWarning(baseline, after);

    expect(warning).toContain("BUILD MISMATCH");
    expect(warning).toContain(baseline.hash);
    expect(warning).toContain(after.hash);
    expect(warning).toContain("0.19.2");
    expect(warning).toContain("0.19.3");
    expect(warning).toContain("does NOT mean the task is wrong");
    expect(warning).toContain("does NOT fail the run or set a verdict");
    expect(warning).toContain("restart the board process");
  });

  it("is loud for a mismatch and quiet for a match", () => {
    const mismatch = servedBuildReport(
      makeResult({ baselineBuild: baseline, servedBuild: after, buildComparison: "mismatch" }),
    );
    expect(mismatch.warning).toBeTypeOf("string");
    expect(mismatch.line).toContain("NOT the build");

    const same = buildServedBuildFingerprint(
      { version: "0.19.3", assetUrls: [], inlineAssets: [BOARD_CSS, BUILD_B] },
      hash,
    );
    const matched = servedBuildReport(
      makeResult({ baselineBuild: after, servedBuild: same, buildComparison: "match" }),
    );
    expect(matched.warning).toBeNull();
    expect(matched.line).toContain("the same build");
  });

  it("says 'cannot compare' in plain language, with no warning, when a side is unmeasurable", () => {
    const blind = buildServedBuildFingerprint(
      { version: UNKNOWN_BUILD, assetUrls: [], inlineAssets: [] },
      hash,
    );

    const firstRun = servedBuildReport(
      makeResult({ baselineBuild: null, servedBuild: after, buildComparison: "no-reference" }),
    );
    expect(firstRun.warning).toBeNull();
    expect(firstRun.line).toContain("Cannot compare builds");
    expect(firstRun.line).toContain("first one");

    for (const report of [
      servedBuildReport(
        makeResult({ baselineBuild: after, servedBuild: blind, buildComparison: "unknown" }),
      ),
      servedBuildReport(
        makeResult({ baselineBuild: blind, servedBuild: after, buildComparison: "no-reference" }),
      ),
      servedBuildReport(makeResult({ baselineBuild: null, servedBuild: null, buildComparison: "unknown" })),
    ]) {
      expect(report.warning).toBeNull();
      expect(report.line).toContain("Cannot compare");
    }
  });

  it("never leaks internal state tokens into the printed output", () => {
    const blind = buildServedBuildFingerprint(
      { version: UNKNOWN_BUILD, assetUrls: [], inlineAssets: [] },
      hash,
    );
    const cases = [
      { baselineBuild: baseline, servedBuild: after, buildComparison: "mismatch" as const },
      { baselineBuild: after, servedBuild: after, buildComparison: "match" as const },
      { baselineBuild: null, servedBuild: after, buildComparison: "no-reference" as const },
      { baselineBuild: after, servedBuild: blind, buildComparison: "unknown" as const },
    ];
    for (const c of cases) {
      const out = loggedOutput(() => printResult(makeResult(c)));
      expect(out).not.toContain("no-reference");
      expect(out).not.toMatch(/\bunknown\b/i);
    }
  });

  it("prints the measured build next to the evidence paths and no warning on a match", () => {
    const result = makeResult({
      baselineBuild: baseline,
      servedBuild: after,
      buildComparison: "match",
    });
    result.evidenceFiles = ["/evidence/verify-after.json"];
    const out = loggedOutput(() => printResult(result));

    expect(out).toContain("Served build measured:");
    expect(out).toContain("the same build");
    expect(out).not.toContain("BUILD MISMATCH");
    // The build line precedes the evidence file list it annotates.
    expect(out.indexOf("Served build measured:")).toBeLessThan(
      out.indexOf("Evidence files"),
    );
  });

  it("prints the mismatch warning where it cannot be skipped", () => {
    const result = makeResult({
      baselineBuild: baseline,
      servedBuild: after,
      buildComparison: "mismatch",
    });
    result.evidenceFiles = ["/evidence/verify-after.json"];
    const out = loggedOutput(() => printResult(result));

    expect(out).toContain("BUILD MISMATCH");
    expect(out).toContain(baseline.hash);
    expect(out).toContain(after.hash);
    expect(out).toContain("restart the board process");
    expect(out).toContain("Served build measured:");
    // Loudness: the warning comes before the diff summary it invalidates.
    expect(out.indexOf("BUILD MISMATCH")).toBeLessThan(out.indexOf("Verdict:"));
  });

  it("prints one plain 'cannot compare' line for a blind run, no warning", () => {
    const result = makeResult({
      baselineBuild: null,
      servedBuild: null,
      buildComparison: "unknown",
    });
    const out = loggedOutput(() => printResult(result));

    expect(out).toContain("Cannot compare builds");
    expect(out).toContain("cannot be determined");
    expect(out).not.toContain("BUILD MISMATCH");
    expect(out).not.toContain("no-reference");
  });
});

// ── 4. The real path: rebuild between two verify runs ──────────────────────
describe("verifyTask records the measured build and warns across a rebuild", () => {
  let tempDir: string;
  let taskId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "verify-build-fp-"));
    const task = createTask(tempDir, {
      title: "Build fingerprint probe",
      description: "probe",
      status: "in-progress",
      selector: ".probe",
      cssSelector: ".probe",
      url: "/kanban",
      author: "probe",
      baseline: makeBaseline(),
    } as unknown as Omit<Task, "id" | "created" | "comments" | "files">);
    taskId = task.id;
    delete (window as unknown as Record<string, unknown>).__NEXT_DATA__;
    serveBoard(BUILD_A);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    document.head.innerHTML = "";
    // clearAllMocks, never restoreAllMocks: the playwright mock's
    // implementations live in the factory and a restore would strip them.
    vi.clearAllMocks();
  });

  function evidence(name: string): Record<string, unknown> {
    const path = join(tempDir, PROTO_DIR, FILES_DIR, taskId, name);
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  }

  it("records the measured build, anchors it with the baseline, then warns on a rebuild", async () => {
    // ── Run 1: first measurement — anchors the reference, warns about nothing.
    const first = await verifyTask(tempDir, taskId, {});
    const firstHash = first.servedBuild.hash;

    expect(first.servedBuild.version).toBe(BOARD_VERSION);
    expect(first.servedBuild.source).toBe("inline-assets");
    expect(firstHash).not.toBe(UNKNOWN_BUILD);
    expect(first.buildComparison).toBe("no-reference");
    expect(first.baselineBuild).toBeNull();

    // The evidence JSON carries the build; the baseline copy anchors it.
    const afterJson = evidence("verify-after.json") as {
      servedBuild: ServedBuildFingerprint;
    };
    expect(afterJson.servedBuild.hash).toBe(firstHash);
    const baselineJson = evidence("baseline.json") as {
      servedBuild: ServedBuildFingerprint;
      servedBuildBaselineCapturedAt: string;
    };
    expect(baselineJson.servedBuild.hash).toBe(firstHash);
    expect(baselineJson.servedBuildBaselineCapturedAt).toBe(
      makeBaseline().capturedAt,
    );

    // ── A rebuild lands: the board process still serves the OLD bundle.
    //    That is the stale-board case — invisible until something compares it.
    const staleFirst = await verifyTask(tempDir, taskId, {});
    expect(staleFirst.buildComparison).toBe("match");

    // ── The board restarts on the NEW bundle: the baseline evidence and this
    //    run now measure two different builds.
    serveBoard(BUILD_B, "0.20.0");

    const second = await verifyTask(tempDir, taskId, {});
    expect(second.buildComparison).toBe("mismatch");
    expect(second.servedBuild.hash).not.toBe(firstHash);
    expect(second.baselineBuild?.hash).toBe(firstHash);

    // EVIDENCE ONLY: a build mismatch must not touch the verdict model.
    expect(second.ok).toBe(first.ok);
    expect(second.verdict).toBe(first.verdict);
    expect(second.buildComparison).not.toBe("fail");

    const printed = loggedOutput(() => printResult(second));
    expect(printed).toContain("BUILD MISMATCH");
    expect(printed).toContain(firstHash.slice(0, 16));
    expect(printed).toContain(second.servedBuild.hash.slice(0, 16));
    expect(printed).toContain("restart the board process");

    // ── The board is restarted on build A again: the mismatch is resolved, and
    //    the anchored reference does not keep crying wolf.
    serveBoard(BUILD_A);
    const third = await verifyTask(tempDir, taskId, {});
    expect(third.buildComparison).toBe("match");
    const printedThird = loggedOutput(() => printResult(third));
    expect(printedThird).not.toContain("BUILD MISMATCH");
  });

  it("re-anchors the reference when the baseline itself is re-captured", async () => {
    await verifyTask(tempDir, taskId, {});
    expect(existsSync(join(tempDir, PROTO_DIR, FILES_DIR, taskId, "baseline.json"))).toBe(
      true,
    );

    serveBoard(BUILD_B);
    // Re-annotation: a new baseline snapshot (new capturedAt) means the old
    // anchor belongs to a snapshot that is no longer the reference.
    const reAnnotated = createTask(tempDir, {
      title: "Build fingerprint probe",
      description: "probe",
      status: "in-progress",
      selector: ".probe",
      cssSelector: ".probe",
      url: "/kanban",
      author: "probe",
      baseline: { ...makeBaseline(), capturedAt: "2026-10-10T10:00:00.000Z" },
    } as unknown as Omit<Task, "id" | "created" | "comments" | "files">);
    taskId = reAnnotated.id;

    const result = await verifyTask(tempDir, taskId, {});
    expect(result.buildComparison).toBe("no-reference");
  });

  it("degrades to 'unknown' when the page exposes no build identity", async () => {
    document.head.innerHTML = "";
    delete (window as unknown as Record<string, unknown>).__CLI_VERSION__;

    const result = await verifyTask(tempDir, taskId, {});

    expect(result.servedBuild.hash).toBe(UNKNOWN_BUILD);
    expect(result.buildComparison).toBe("unknown");
    const printed = loggedOutput(() => printResult(result));
    expect(printed).toContain("Cannot compare builds");
    expect(printed).toContain("cannot be determined");
    expect(printed).not.toContain("BUILD MISMATCH");
  });
});

// ── 5. Capture helper ──────────────────────────────────────────────────────
describe("captureServedBuildFingerprint", () => {
  it("never throws when the page cannot be measured", async () => {
    const failingPage = {
      evaluate: vi.fn().mockRejectedValue(new Error("execution context destroyed")),
    } as unknown as import("playwright").Page;

    const fp = await captureServedBuildFingerprint(failingPage);

    expect(fp.hash).toBe(UNKNOWN_BUILD);
    expect(fp.source).toBe("none");
  });

  it("hashes with sha256 so the same build yields the same value", async () => {
    serveBoard(BUILD_A);
    const page = {
      evaluate: vi.fn(async (fn: () => unknown) => fn()),
    } as unknown as import("playwright").Page;

    const a = await captureServedBuildFingerprint(page);
    const b = await captureServedBuildFingerprint(page);

    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash);
  });
});
