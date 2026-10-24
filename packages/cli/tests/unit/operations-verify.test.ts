/**
 * Verify operations (ticket 453c7465, P7 verify increment).
 *
 * Pins the two deltas the previous lane flagged and did NOT resolve, plus
 * the no-behaviour-change contract of the extraction itself:
 *
 * (a) double-timer — the CLI handler installed an AbortController + timer
 *     AND the shared operation installed its own. Correct behaviour: ONE
 *     timer, owned by the operation; the CLI passes `timeoutMs` through and
 *     installs nothing. The operation also reports the RESOLVED bound in its
 *     VERIFY_TIMEOUT text (the old code interpolated the possibly-absent raw
 *     input and printed "undefinedms" when the schema default applied).
 * (b) prefix-resolution — the CLI engine form looked the task file up
 *     EXACTLY (a prefix died with E_NOT_FOUND) while the MCP form resolved a
 *     first-match prefix (an ambiguous prefix silently verified the wrong
 *     task). Correct behaviour, pinned here: the shared unique-prefix rule —
 *     exact id wins, a UNIQUE prefix resolves, an ambiguous prefix is refused
 *     E_AMBIGUOUS, an unknown id passes through so the engine raises its own
 *     E_NOT_FOUND. The dry-run preview resolves through the same rule, so it
 *     names the same task the live call verifies.
 *
 * Everything runs through the operation's injected ports: no browser, no
 * store writes, no real timers — the fakes below assert the exact args.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OperationContext } from "../../src/core/operations.js";
import { VERIFY_ERROR_SUGGESTION } from "../../src/core/operations.js";
import {
  verifyTaskOp,
  inspectVerificationEvidence,
  type VerifyEngineFn,
} from "../../src/core/operations/verify.js";
import type { VerifyResult } from "../../src/commands/verify.js";
import type { EvidenceSet } from "../../src/commands/verify-tools.js";

let projectDir: string;
let ctx: OperationContext;

function seedTask(id: string) {
  const created = "2026-01-01T00:00:00.000Z";
  const task = {
    id,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    selector: "/",
    created,
    comments: [],
    files: [],
  };
  const dateDir = join(projectDir, ".vibeflow", "tasks", created.slice(0, 10));
  mkdirSync(dateDir, { recursive: true });
  writeFileSync(join(dateDir, `${id}.json`), JSON.stringify(task, null, 2));
}

function fakeResult(taskId: string): VerifyResult {
  return {
    taskId,
    ok: true,
    taskDescription: "",
    baseline: {
      selector: ".x",
      url: "",
      capturedAt: "2026-01-01T00:00:00.000Z",
      snapshot: {},
    },
    after: { snapshot: {}, consoleErrors: [] },
    diff: {},
    evidenceFiles: [],
    verdict: "fake",
    captureTruncated: false,
    servedBuild: {
      hash: "unknown",
      version: "unknown",
      assetUrls: [],
      source: "none",
      capturedAt: "2026-01-01T00:00:00.000Z",
    },
    baselineBuild: null,
    buildComparison: "unknown",
  } as unknown as VerifyResult;
}

function fakeEvidence(): EvidenceSet {
  return {
    taskId: "t",
    baseline: { color: "red" },
    after: { color: "blue" },
    diff: { color: ["red", "blue"] as [string, string] },
    consoleText: "(no console errors)",
    baselineHtml: "<div>a</div>",
    afterHtml: "<div>b</div>",
    selector: ".x",
    position: null,
    allStyles: null,
    pageBaseline: null,
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "op-verify-"));
  ctx = { projectDir, mode: "local" };
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("verifyTaskOp — delta (a): one timer, owned by the operation", () => {
  it("installs exactly one timer and clears it, reporting the resolved bound", async () => {
    seedTask("timer-task-1");
    const setTimer = vi.fn((_h: () => void, _ms: number) => ({ fake: true }));
    const clearTimer = vi.fn((_h: unknown) => {});
    const runEngine: VerifyEngineFn = vi.fn(async () => fakeResult("timer-task-1"));
    const writeComment = vi.fn(async () => {});

    // Abort the bound from the captured handler, then fail the engine with a
    // plain (codeless) error: the op maps an aborted signal to
    // VERIFY_TIMEOUT, which must name the bound that actually fired.
    const abortingEngine: VerifyEngineFn = async (_dir, _id, opts) => {
      opts.signal?.addEventListener("abort", () => {});
      throw new Error("boom");
    };
    const result = await verifyTaskOp(
      ctx,
      { id: "timer-task-1", timeoutMs: 60_000, dryRun: false },
      {
        runEngine: abortingEngine,
        writeComment,
        setTimer: ((h: () => void) => {
          setTimer(h, 60_000);
          // Fire immediately: the signal aborts before the engine throws,
          // so the refusal takes the VERIFY_TIMEOUT branch.
          h();
          return { fake: true };
        }) as (h: () => void, ms: number) => unknown,
        clearTimer,
      },
    );

    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("VERIFY_TIMEOUT");
    expect(result.error?.message).toContain("60000ms");
    expect(runEngine).not.toHaveBeenCalled();
    expect(writeComment).not.toHaveBeenCalled();
  });

  it("reports the default bound, never 'undefinedms', when timeoutMs is omitted", async () => {
    seedTask("timer-task-2");
    const seen: number[] = [];
    const abortingEngine: VerifyEngineFn = async () => {
      throw new Error("boom");
    };
    const result = await verifyTaskOp(
      ctx,
      // No timeoutMs: the schema default (60000) applies on the MCP wire.
      // Omit it here to pin the fallback text.
      { id: "timer-task-2", timeoutMs: undefined as unknown as number, dryRun: false },
      {
        runEngine: abortingEngine,
        writeComment: async () => {},
        setTimer: ((h: () => void, ms: number) => {
          seen.push(ms);
          h();
          return { fake: true };
        }) as (h: () => void, ms: number) => unknown,
        clearTimer: () => {},
      },
    );

    expect(seen).toEqual([60_000]);
    expect(result.error?.code).toBe("VERIFY_TIMEOUT");
    expect(result.error?.message).toBe(
      "Verification timed out after 60000ms",
    );
    expect(result.error?.message).not.toContain("undefined");
  });
});

describe("verifyTaskOp — delta (b): the shared unique-prefix rule", () => {
  it("exact id reaches the engine and the comment verbatim", async () => {
    seedTask("exact-task-9");
    const runEngine: VerifyEngineFn = vi.fn(async (_d, id) => fakeResult(id));
    const writeComment = vi.fn(async () => {});
    const result = await verifyTaskOp(
      ctx,
      { id: "exact-task-9", timeoutMs: 60_000, dryRun: false },
      { runEngine, writeComment },
    );
    expect(result.ok).toBe(true);
    expect(runEngine).toHaveBeenCalledWith(
      projectDir,
      "exact-task-9",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(writeComment).toHaveBeenCalledWith(
      projectDir,
      "exact-task-9",
      expect.objectContaining({ taskId: "exact-task-9" }),
    );
  });

  it("a UNIQUE prefix resolves to the full id for both engine and comment", async () => {
    seedTask("prefix-task-abc");
    const runEngine: VerifyEngineFn = vi.fn(async (_d, id) => fakeResult(id));
    const writeComment = vi.fn(async () => {});
    const result = await verifyTaskOp(
      ctx,
      { id: "prefix-task-a", timeoutMs: 60_000, dryRun: false },
      { runEngine, writeComment },
    );
    expect(result.ok).toBe(true);
    expect(runEngine).toHaveBeenCalledWith(
      projectDir,
      "prefix-task-abc",
      expect.anything(),
    );
    expect(writeComment).toHaveBeenCalledWith(
      projectDir,
      "prefix-task-abc",
      expect.anything(),
    );
  });

  it("an AMBIGUOUS prefix is refused E_AMBIGUOUS and the engine never runs", async () => {
    seedTask("clash-1");
    seedTask("clash-2");
    const runEngine: VerifyEngineFn = vi.fn(async (_d, id) => fakeResult(id));
    const writeComment = vi.fn(async () => {});
    const result = await verifyTaskOp(
      ctx,
      { id: "clash", timeoutMs: 60_000, dryRun: false },
      { runEngine, writeComment },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E_AMBIGUOUS");
    expect(result.error?.message).toContain("clash-1");
    expect(result.error?.message).toContain("clash-2");
    expect(runEngine).not.toHaveBeenCalled();
    expect(writeComment).not.toHaveBeenCalled();
  });

  it("an unknown id passes through so the engine raises its own E_NOT_FOUND", async () => {
    const engineError = Object.assign(new Error("Task not found: nope-zzz"), {
      code: "E_NOT_FOUND",
    });
    const runEngine: VerifyEngineFn = vi.fn(async () => {
      throw engineError;
    });
    const result = await verifyTaskOp(
      ctx,
      { id: "nope-zzz", timeoutMs: 60_000, dryRun: false },
      { runEngine, writeComment: async () => {} },
    );
    // The raw id reaches the engine (not renamed, not resolved to null).
    expect(runEngine).toHaveBeenCalledWith(
      projectDir,
      "nope-zzz",
      expect.anything(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E_NOT_FOUND");
  });

  it("dry-run preview names the same task the live call verifies", async () => {
    seedTask("preview-task-abc");
    const runEngine: VerifyEngineFn = vi.fn(async (_d, id) => fakeResult(id));
    const preview = await verifyTaskOp(
      ctx,
      { id: "preview-task-a", timeoutMs: 60_000, dryRun: true },
      { runEngine, writeComment: async () => {} },
    );
    expect(preview.ok).toBe(true);
    expect(
      (preview.data as { id: string }).id,
    ).toBe("preview-task-abc");
    expect(preview.steps).toEqual([
      { code: "DRY_RUN", message: "Verification would run" },
    ]);
    expect(runEngine).not.toHaveBeenCalled();
  });

  it("dry-run preview refuses an ambiguous prefix without launching anything", async () => {
    seedTask("dry-clash-1");
    seedTask("dry-clash-2");
    const runEngine: VerifyEngineFn = vi.fn(async (_d, id) => fakeResult(id));
    const preview = await verifyTaskOp(
      ctx,
      { id: "dry-clash", timeoutMs: 60_000, dryRun: true },
      { runEngine, writeComment: async () => {} },
    );
    expect(preview.ok).toBe(false);
    expect(preview.error?.code).toBe("E_AMBIGUOUS");
    expect(runEngine).not.toHaveBeenCalled();
  });
});

describe("verifyTaskOp — characterization: engine errors pass through", () => {
  it("an engine code with no suggestion of its own gains the fallback", async () => {
    seedTask("suggestion-task");
    const runEngine: VerifyEngineFn = async () => {
      throw Object.assign(new Error("Task has no CSS selector."), {
        code: "E_NO_SELECTOR",
      });
    };
    const result = await verifyTaskOp(
      ctx,
      { id: "suggestion-task", timeoutMs: 60_000, dryRun: false },
      { runEngine, writeComment: async () => {} },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E_NO_SELECTOR");
    expect(result.error?.suggestion).toBe(VERIFY_ERROR_SUGGESTION);
  });

  it("an engine suggestion of its own always wins over the fallback", async () => {
    seedTask("suggestion-task-2");
    const runEngine: VerifyEngineFn = async () => {
      throw Object.assign(new Error("No baseline."), {
        code: "E_NO_BASELINE",
        suggestion: "Re-annotate.",
      });
    };
    const result = await verifyTaskOp(
      ctx,
      { id: "suggestion-task-2", timeoutMs: 60_000, dryRun: false },
      { runEngine, writeComment: async () => {} },
    );
    expect(result.error?.code).toBe("E_NO_BASELINE");
    expect(result.error?.suggestion).toBe("Re-annotate.");
  });
});

describe("inspectVerificationEvidence — data half of the evidence forms", () => {
  it("style_query dispatches the loaded evidence and returns the query data", async () => {
    seedTask("ev-task-1");
    const opResult = await inspectVerificationEvidence(
      ctx,
      { taskId: "ev-task-1", tool: "style_query", property: "color" },
      { loadEvidence: async () => fakeEvidence() },
    );
    expect(opResult.ok).toBe(true);
    expect(opResult.data).toMatchObject({
      ok: true,
      tool: "style_query",
      property: "color",
      baseline: "red",
      after: "blue",
      changed: true,
    });
  });

  it("a UNIQUE prefix resolves before the evidence load", async () => {
    seedTask("ev-prefix-abc");
    const seen: string[] = [];
    const opResult = await inspectVerificationEvidence(
      ctx,
      { taskId: "ev-prefix-a", tool: "element_info" },
      {
        loadEvidence: async (_dir, id) => {
          seen.push(id);
          return fakeEvidence();
        },
      },
    );
    expect(seen).toEqual(["ev-prefix-abc"]);
    expect(opResult.ok).toBe(true);
    expect(opResult.data).toMatchObject({ ok: true, tool: "element_info" });
  });

  it("an unknown id is refused E_NOT_FOUND with the renderer's wording", async () => {
    const loadEvidence = vi.fn(async () => fakeEvidence());
    const opResult = await inspectVerificationEvidence(
      ctx,
      { taskId: "ev-missing", tool: "style_diff" },
      { loadEvidence },
    );
    expect(opResult.ok).toBe(false);
    expect(opResult.error?.code).toBe("E_NOT_FOUND");
    expect(opResult.error?.message).toBe("Task not found: ev-missing");
    expect(loadEvidence).not.toHaveBeenCalled();
  });

  it("an ambiguous prefix is refused E_AMBIGUOUS", async () => {
    seedTask("ev-clash-1");
    seedTask("ev-clash-2");
    const loadEvidence = vi.fn(async () => fakeEvidence());
    const opResult = await inspectVerificationEvidence(
      ctx,
      { taskId: "ev-clash", tool: "html_diff" },
      { loadEvidence },
    );
    expect(opResult.ok).toBe(false);
    expect(opResult.error?.code).toBe("E_AMBIGUOUS");
    expect(loadEvidence).not.toHaveBeenCalled();
  });

  it("a malformed artifact is refused E_EVIDENCE_MALFORMED with the loader text", async () => {
    seedTask("ev-bad-1");
    const opResult = await inspectVerificationEvidence(
      ctx,
      { taskId: "ev-bad-1", tool: "style_diff" },
      {
        loadEvidence: async () => {
          throw new Error(
            "baseline.json for task ev-bad-1 is not valid JSON: boom. Re-run verify to regenerate it.",
          );
        },
      },
    );
    expect(opResult.ok).toBe(false);
    expect(opResult.error?.code).toBe("E_EVIDENCE_MALFORMED");
    expect(opResult.error?.message).toContain("not valid JSON");
  });

  it("tool-level misses travel as DATA, never as refusals", async () => {
    seedTask("ev-usage-1");
    const ports = { loadEvidence: async () => fakeEvidence() };
    const unknown = await inspectVerificationEvidence(
      ctx,
      { taskId: "ev-usage-1", tool: "nope" },
      ports,
    );
    expect(unknown).toEqual({
      ok: true,
      data: { ok: false, error: "Unknown tool: nope" },
    });
    const noProp = await inspectVerificationEvidence(
      ctx,
      { taskId: "ev-usage-1", tool: "style_query" },
      ports,
    );
    expect(noProp).toEqual({
      ok: true,
      data: {
        ok: false,
        error: "Usage: vibeflow verify style_query <task-id> <property>",
      },
    });
    const badQuery = await inspectVerificationEvidence(
      ctx,
      { taskId: "ev-usage-1", tool: "html_query", queryType: "bogus" },
      ports,
    );
    expect(badQuery).toEqual({
      ok: true,
      data: {
        ok: false,
        error:
          "Usage: vibeflow verify html_query <task-id> children|text|attributes",
      },
    });
  });

  it("missing evidence files surface as tool-level misses, not refusals", async () => {
    seedTask("ev-empty-1");
    const opResult = await inspectVerificationEvidence(
      ctx,
      { taskId: "ev-empty-1", tool: "style_diff" },
      {
        loadEvidence: async () => ({
          ...fakeEvidence(),
          diff: null,
        }),
      },
    );
    expect(opResult).toEqual({
      ok: true,
      data: {
        ok: false,
        error:
          "No verify-diff.json found. Run 'vibeflow verify <task-id>' first.",
      },
    });
  });
});
