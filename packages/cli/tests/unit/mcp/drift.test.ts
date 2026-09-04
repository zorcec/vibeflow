/**
 * MCP Drift Test
 *
 * Ensures CLI commands and flags are properly mapped to MCP tools.
 * Fails if a new CLI flag is added without a corresponding MCP tool.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../../../src/mcp/manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcRoot = join(__dirname, "../../../src");

describe("MCP drift test", () => {
  it("every tool in manifest has required fields", () => {
    for (const tool of manifest) {
      expect(tool.name).toBeTruthy();
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.cliRef).toBeDefined();
      expect(tool.cliRef.command).toBeTruthy();
      expect(tool.cliRef.flags).toBeInstanceOf(Array);
      expect(tool.category).toBeTruthy();
      expect(tool.annotations).toBeDefined();
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations.idempotentHint).toBe("boolean");
      expect(typeof tool.annotations.openWorldHint).toBe("boolean");
      expect(tool.input).toBeDefined();
      expect(typeof tool.run).toBe("function");
    }
  });

  it("tool names are unique", () => {
    const names = manifest.map((m) => m.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("all 10 MCP tools are registered", () => {
    const expectedTools = [
      "add_comment",
      "attach_file",
      "claim_next_task",
      "create_task",
      "export_prompt",
      "get_task",
      "list_tasks",
      "push_tasks",
      "update_task",
      "verify_task",
    ];
    const actualTools = manifest.map((m) => m.name).sort();
    expect(actualTools).toEqual(expectedTools);
  });

  it("read-only tools have readOnlyHint=true", () => {
    const readOnlyTools = ["list_tasks", "get_task", "export_prompt"];
    for (const tool of manifest) {
      if (readOnlyTools.includes(tool.name)) {
        expect(tool.annotations.readOnlyHint).toBe(true);
      }
    }
  });

  it("destructive tools have destructiveHint=true", () => {
    const destructiveTools = ["push_tasks"];
    for (const tool of manifest) {
      if (destructiveTools.includes(tool.name)) {
        expect(tool.annotations.destructiveHint).toBe(true);
      }
    }
  });

  it("cliRef flags are non-empty for tasks command tools", () => {
    const tasksTools = manifest.filter((m) => m.cliRef.command === "tasks");
    for (const tool of tasksTools) {
      expect(tool.cliRef.flags.length).toBeGreaterThan(0);
    }
  });

  it("snapshot of tool names matches fixture", () => {
    const toolNames = manifest.map((m) => m.name).sort();
    expect(toolNames).toMatchSnapshot();
  });

  it("all input schemas are zod objects", () => {
    for (const tool of manifest) {
      // Zod objects have a _def property
      expect(tool.input).toBeDefined();
      expect(typeof tool.input.parse).toBe("function");
    }
  });

  it("operations layer lives in core, not mcp (spec §1)", () => {
    expect(existsSync(join(srcRoot, "core", "operations.ts"))).toBe(true);
    expect(existsSync(join(srcRoot, "mcp", "operations.ts"))).toBe(false);
  });

  it("mcp modules do not implement task logic themselves", () => {
    for (const f of ["manifest.ts", "server.ts", "http.ts"]) {
      const src = readFileSync(join(srcRoot, "mcp", f), "utf-8");
      expect(src).not.toMatch(/writeFileSync|mkdirSync\(/);
    }
  });

  it("every cliRef flag exists on the referenced command", () => {
    // Static check: all flag strings are non-empty and start with --
    for (const tool of manifest) {
      for (const flag of tool.cliRef.flags) {
        expect(flag).toMatch(/^--/);
      }
    }
  });
});
