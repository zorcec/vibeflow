/**
 * Auxiliary operation pins (ticket 9c1217b1, P6 increment 1).
 *
 * `getChangelog`, `getOpenApiDocument`, `manageTelemetry` and
 * `linkCommitAuthors` are CLI-only local operations (no MCP tools), driven
 * here in local mode against injected port fakes — never HOME, the bundle
 * layout, git, or the network:
 *
 * - changelog selects the newest packed section by default and every
 *   section with `all`; an unreadable store reports `empty` (the renderer
 *   owns the "no changelog" line);
 * - openapi selects the JSON twin by default and the YAML twin with
 *   `yaml`; the bytes pass through untouched (no envelope, no colour);
 * - telemetry routes enable/disable/status to the config ports: enable and
 *   disable write exactly once with the matching boolean, status never
 *   writes, and the env-override flag rides the result;
 * - authors link forwards the project directory and the dry-run flag to
 *   the enrichment service untouched and returns its report verbatim,
 *   including the git-unavailable refusal (the renderer owns the exit-1
 *   rule).
 *
 * The CLI envelopes, exit codes and human blocks over these results are
 * pinned by the unchanged renderer branches in src/index.ts (same prints,
 * same order) and the existing command suites.
 */
import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "../../src/core/operations.js";
import {
  getChangelog,
  getOpenApiDocument,
  manageTelemetry,
  linkCommitAuthors,
} from "../../src/core/operations.js";
import type { AuthorsLinkResult } from "../../src/commands/authors.js";

const ctx: OperationContext = { projectDir: "/tmp/p6-aux-test", mode: "local" };

const TWO_SECTIONS = [
  "## 2.0.0",
  "",
  "Latest stuff.",
  "",
  "## 1.0.0",
  "",
  "Older stuff.",
  "",
].join("\n");

function emptyReport(): AuthorsLinkResult {
  return {
    linked: 0,
    alreadyLinked: 0,
    unresolved: 0,
    conflicts: 0,
    conflictDetails: [],
    gitAvailable: true,
    filesChanged: 0,
    distinctShas: 0,
  };
}

describe("getChangelog", () => {
  it("selects the newest section by default", async () => {
    const readContent = vi.fn(() => TWO_SECTIONS);
    const result = await getChangelog(ctx, { readContent });
    expect(result.ok).toBe(true);
    expect(readContent).toHaveBeenCalledTimes(1);
    expect(result.data.all).toBe(false);
    expect(result.data.empty).toBe(false);
    expect(result.data.text).toContain("2.0.0");
    expect(result.data.text).not.toContain("1.0.0");
  });

  it("selects every section with all", async () => {
    const result = await getChangelog(ctx, {
      all: true,
      readContent: () => TWO_SECTIONS,
    });
    expect(result.data.all).toBe(true);
    expect(result.data.text).toContain("2.0.0");
    expect(result.data.text).toContain("1.0.0");
  });

  it("reports empty when the store is unreadable", async () => {
    const result = await getChangelog(ctx, { readContent: () => null });
    expect(result).toEqual({ ok: true, data: { all: false, text: "", empty: true } });
  });
});

describe("getOpenApiDocument", () => {
  it("selects the JSON twin by default and passes bytes through", async () => {
    const readSpec = vi.fn((yaml: boolean) => (yaml ? "YAML" : '{"openapi":"x"}'));
    const result = await getOpenApiDocument(ctx, { readSpec });
    expect(readSpec).toHaveBeenCalledWith(false);
    expect(result).toEqual({
      ok: true,
      data: { yaml: false, content: '{"openapi":"x"}' },
    });
  });

  it("selects the YAML twin with yaml", async () => {
    const readSpec = vi.fn((yaml: boolean) => (yaml ? "YAML" : "JSON"));
    const result = await getOpenApiDocument(ctx, { yaml: true, readSpec });
    expect(readSpec).toHaveBeenCalledWith(true);
    expect(result.data).toEqual({ yaml: true, content: "YAML" });
  });
});

describe("manageTelemetry", () => {
  it("enable writes true once and reports the status", async () => {
    const setEnabled = vi.fn();
    const result = await manageTelemetry(ctx, {
      action: "enable",
      setEnabled,
      getStatus: () => ({ enabled: true, anonymousId: "abc" }),
      isEnvDisabled: () => false,
    });
    expect(setEnabled).toHaveBeenCalledTimes(1);
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(result).toEqual({
      ok: true,
      data: {
        action: "enable",
        enabled: true,
        anonymousId: "abc",
        envOverride: false,
      },
    });
  });

  it("disable writes false once", async () => {
    const setEnabled = vi.fn();
    const result = await manageTelemetry(ctx, {
      action: "disable",
      setEnabled,
      getStatus: () => ({ enabled: false, anonymousId: null }),
      isEnvDisabled: () => false,
    });
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(result.data.action).toBe("disable");
    expect(result.data.enabled).toBe(false);
  });

  it("status never writes and surfaces the env override", async () => {
    const setEnabled = vi.fn();
    const result = await manageTelemetry(ctx, {
      action: "status",
      setEnabled,
      getStatus: () => ({ enabled: false, anonymousId: "abc" }),
      isEnvDisabled: () => true,
    });
    expect(setEnabled).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      action: "status",
      enabled: false,
      anonymousId: "abc",
      envOverride: true,
    });
  });
});

describe("linkCommitAuthors", () => {
  it("forwards projectDir and dryRun to the service and returns the report", async () => {
    const report = { ...emptyReport(), linked: 3, filesChanged: 2 };
    const runEnrichment = vi.fn(() => report);
    const result = await linkCommitAuthors(
      { projectDir: "/repo", mode: "local" },
      { dryRun: true, runEnrichment },
    );
    expect(runEnrichment).toHaveBeenCalledTimes(1);
    expect(runEnrichment).toHaveBeenCalledWith("/repo", { dryRun: true });
    expect(result).toEqual({ ok: true, data: { dryRun: true, report } });
  });

  it("omits dryRun for a live run and propagates the git-unavailable refusal as data", async () => {
    const report = { ...emptyReport(), gitAvailable: false };
    const runEnrichment = vi.fn(() => report);
    const result = await linkCommitAuthors(
      { projectDir: "/repo", mode: "local" },
      { runEnrichment },
    );
    expect(runEnrichment).toHaveBeenCalledWith("/repo", {});
    expect(result.data.dryRun).toBe(false);
    expect(result.data.report.gitAvailable).toBe(false);
  });
});
