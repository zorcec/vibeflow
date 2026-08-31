import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock the tasks module to avoid real task file lookups
vi.mock("../../../src/core/tasks.js", () => ({
  findTaskFilePath: vi.fn().mockReturnValue("/fake/task.json"),
  readTaskFile: vi.fn().mockReturnValue({ id: "test-task-123", description: "test" }),
}));

// Mock the files module
vi.mock("../../../src/core/files.js", () => ({
  getFilesDir: vi.fn().mockImplementation((_dir: string, taskId: string) => `/fake/files/${taskId}`),
}));

import {
  readEvidence,
  queryStyle,
  diffStyles,
  elementInfo,
  htmlDiff,
  runVerifyTool,
  VERIFY_TOOLS,
} from "../../../src/commands/verify-tools.js";
import { existsSync, readdirSync } from "node:fs";

// ── Helpers ──────────────────────────────────────────────────────────────
function mkEvidenceDir(taskId: string, files: Record<string, string>) {
  const dir = `/fake/files/${taskId}`;
  // We can't actually write to /fake, so we test the functions with inline data
}

// ── Tests ────────────────────────────────────────────────────────────────
describe("VERIFY_TOOLS", () => {
  it("contains all five tools", () => {
    expect(VERIFY_TOOLS.has("style_query")).toBe(true);
    expect(VERIFY_TOOLS.has("style_diff")).toBe(true);
    expect(VERIFY_TOOLS.has("element_info")).toBe(true);
    expect(VERIFY_TOOLS.has("html_diff")).toBe(true);
    expect(VERIFY_TOOLS.has("html_query")).toBe(true);
    expect(VERIFY_TOOLS.size).toBe(5);
  });
});

describe("queryStyle", () => {
  const ev = {
    taskId: "test-task",
    baseline: { "overflow": "visible", "overflow-y": "hidden", "font-size": "14px" },
    after: { "overflow": "auto", "overflow-y": "auto", "font-size": "16px" },
    diff: {
      "overflow": ["visible", "auto"] as [string, string],
      "overflow-y": ["hidden", "auto"] as [string, string],
      "font-size": ["14px", "16px"] as [string, string],
    },
    consoleText: null,
    baselineHtml: null,
    afterHtml: null,
    selector: ".test",
    position: null,
  };

  it("returns changed property", () => {
    const result = queryStyle(ev, "overflow") as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.baseline).toBe("visible");
    expect(result.after).toBe("auto");
    expect(result.changed).toBe(true);
  });

  it("returns unchanged property", () => {
    const ev2 = {
      ...ev,
      diff: {} as Record<string, [string, string]>,
    };
    const result = queryStyle(ev2, "margin") as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.baseline).toBeNull();
    expect(result.after).toBeNull();
    expect(result.changed).toBe(false);
  });

  it("returns not-found property", () => {
    const ev2 = {
      ...ev,
      baseline: { "overflow": "visible" },
      after: { "overflow": "auto" },
      diff: { "overflow": ["visible", "auto"] } as Record<string, [string, string]>,
    };
    const result = queryStyle(ev2, "color") as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.baseline).toBeNull();
    expect(result.after).toBeNull();
    expect(result.changed).toBe(false);
  });

  it("returns error when after is null", () => {
    const result = queryStyle({ ...ev, after: null }, "overflow") as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("diffStyles", () => {
  const ev = {
    taskId: "test-task",
    baseline: null,
    after: null,
    diff: {
      "overflow": ["visible", "auto"] as [string, string],
      "overflow-y": ["hidden", "auto"] as [string, string],
      "text-decoration": ["line-through", "none"] as [string, string],
    },
    consoleText: null,
    baselineHtml: null,
    afterHtml: null,
    selector: null,
    position: null,
  };

  it("returns all changed properties", () => {
    const result = diffStyles(ev) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.total).toBe(3);
    expect(result.matched).toBe(3);
    expect(Object.keys(result.styles as Record<string, unknown>)).toHaveLength(3);
  });

  it("filters by substring", () => {
    const result = diffStyles(ev, "overflow") as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.total).toBe(3);
    expect(result.matched).toBe(2);
    expect(Object.keys(result.styles as Record<string, unknown>)).toContain("overflow");
    expect(Object.keys(result.styles as Record<string, unknown>)).toContain("overflow-y");
  });

  it("returns empty when filter doesn't match", () => {
    const result = diffStyles(ev, "font") as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.total).toBe(3);
    expect(result.matched).toBe(0);
  });

  it("returns error when diff is null", () => {
    const result = diffStyles({ ...ev, diff: null }) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("elementInfo", () => {
  it("returns element info with no console errors", () => {
    const ev = {
      taskId: "test-task",
      baseline: null,
      after: { "overflow": "auto" },
      diff: null,
      consoleText: "(no console errors)",
      baselineHtml: null,
      afterHtml: null,
      selector: ".board-column",
      position: { boundingBox: { x: 100, y: 200, width: 300, height: 150 } },
    };
    const result = elementInfo(ev) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.selector).toBe(".board-column");
    expect(result.position).toBeDefined();
    expect(result.consoleErrors).toEqual([]);
  });

  it("returns console errors", () => {
    const ev = {
      taskId: "test-task",
      baseline: null,
      after: { "overflow": "auto" },
      diff: null,
      consoleText: "Error: test error\nAnother error",
      baselineHtml: null,
      afterHtml: null,
      selector: ".board-column",
      position: null,
    };
    const result = elementInfo(ev) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.consoleErrors).toHaveLength(2);
  });

  it("returns error when after is null", () => {
    const ev = {
      taskId: "test-task",
      baseline: null,
      after: null,
      diff: null,
      consoleText: null,
      baselineHtml: null,
      afterHtml: null,
      selector: null,
      position: null,
    };
    const result = elementInfo(ev) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });
});

describe("htmlDiff", () => {
  it("returns changed HTML", () => {
    const ev = {
      taskId: "test-task",
      baseline: null,
      after: null,
      diff: null,
      consoleText: null,
      baselineHtml: "<div class='old'>Hello</div>",
      afterHtml: "<div class='new'>Hello World</div>",
      selector: null,
      position: null,
    };
    const result = htmlDiff(ev) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.htmlChanged).toBe(true);
    expect(result.baselineChars).toBe(28);
    expect(result.afterChars).toBe(34);
  });

  it("returns unchanged HTML", () => {
    const ev = {
      taskId: "test-task",
      baseline: null,
      after: null,
      diff: null,
      consoleText: null,
      baselineHtml: "<div>Hello</div>",
      afterHtml: "<div>Hello</div>",
      selector: null,
      position: null,
    };
    const result = htmlDiff(ev) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.htmlChanged).toBe(false);
  });

  it("returns error when afterHtml is null", () => {
    const ev = {
      taskId: "test-task",
      baseline: null,
      after: null,
      diff: null,
      consoleText: null,
      baselineHtml: null,
      afterHtml: null,
      selector: null,
      position: null,
    };
    const result = htmlDiff(ev) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });
});

describe("runVerifyTool", () => {
  it("returns error when task ID is missing", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runVerifyTool(".", "style_query", []);
    expect(stderrWrite).toHaveBeenCalled();
    stderrWrite.mockRestore();
  });
});
