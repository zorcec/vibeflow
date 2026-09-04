import { describe, it, expect } from "vitest";
import { manifest } from "../../src/mcp/manifest.js";

describe("MCP manifest single source", () => {
  it("has exactly 10 tools", () => {
    expect(manifest.length).toBe(10);
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
      expect(tool.cliRef.flags.length).toBeGreaterThan(0);
    }
  });
});
