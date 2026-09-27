import { describe, it, expect } from "vitest";
import { manifest } from "../../src/mcp/manifest.js";

describe("MCP manifest single source", () => {
  it("has exactly 11 tools", () => {
    expect(manifest.length).toBe(11);
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
