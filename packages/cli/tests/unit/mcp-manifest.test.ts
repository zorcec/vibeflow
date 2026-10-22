import { describe, it, expect } from "vitest";
import { manifest } from "../../src/mcp/manifest.js";
import {
  CLI_ONLY_MCP_TOOLS,
  HOSTED_MCP_TOOL_DECLARATIONS,
} from "@vibeflow-tools/api-core/mcp-tools";

describe("MCP manifest single source", () => {

  it("partitions every declared tool into hosted or CLI-only — never both, never neither", () => {
    // The hosted surface (cloud) and the local CLI both consume this module.
    // A tool that is in NEITHER bucket is unrunnable anywhere; one in BOTH is a
    // silent fork. `pull` was added to the declarations and the hosted list was
    // not updated — the partition is what makes that impossible to ship again.
    const all = manifest.map((tool) => tool.name).sort();
    const hosted = HOSTED_MCP_TOOL_DECLARATIONS.map((tool) => tool.name);
    const cliOnly = [...CLI_ONLY_MCP_TOOLS];

    expect(hosted.filter((name) => cliOnly.includes(name))).toEqual([]);
    expect([...hosted, ...cliOnly].sort()).toEqual(all);
    expect(new Set([...hosted, ...cliOnly]).size).toBe(all.length);
  });

  it("`pull` is declared CLI-only, and it exists", () => {
    // A hosted MCP server has no project directory to pull into. The exclusion
    // is declared in api-core so the hosted surface cannot answer a different
    // set of names without a decision.
    expect([...CLI_ONLY_MCP_TOOLS]).toEqual(["pull"]);
    expect(manifest.map((tool) => tool.name)).toContain("pull");
    expect(
      HOSTED_MCP_TOOL_DECLARATIONS.map((tool) => tool.name),
    ).not.toContain("pull");
  });

  it("has exactly 12 tools", () => {
    // Ticket 53b622fc: export_prompt was REMOVED (breaking) — 12 became 11.
    // Then `pull` was added (board -> local additive sync), back to 12. The
    // count is pinned deliberately: a tool appearing or vanishing without a
    // decision should break this file, and drift.test.ts names `pull` as the
    // twelfth so the two cannot disagree.
    expect(manifest.length).toBe(12);
  });

  it("export_prompt is absent (removed, ticket 53b622fc)", () => {
    expect(manifest.some((t) => t.name === "export_prompt")).toBe(false);
  });

  it("push_tasks is absent (hidden CLI push, intentionally unexposed)", () => {
    expect(manifest.some((t) => t.name === "push_tasks")).toBe(false);
  });

  it("all tool names are unique", () => {
    const names = manifest.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every input is a ZodRawShape (plain object of ZodType)", () => {
    for (const tool of manifest) {
      expect(typeof tool.input).toBe("object");
      expect(tool.input).not.toBeNull();
      for (const [key, val] of Object.entries(tool.input)) {
        expect(typeof (val as { parse?: unknown }).parse).toBe("function");
      }
    }
  });

  it("all tools have required metadata fields", () => {
    for (const tool of manifest) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.cliRef.command).toBeTruthy();
      // Scoped to the `tasks` command: a command with no options (status →
      // get_project) honestly maps to flags: []. Mirrors drift.test.ts's
      // "cliRef flags are non-empty for tasks command tools".
      if (tool.cliRef.command === "tasks") {
        expect(tool.cliRef.flags.length).toBeGreaterThan(0);
      }
    }
  });
});
