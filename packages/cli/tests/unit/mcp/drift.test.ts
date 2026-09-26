/**
 * MCP Drift Test
 *
 * Ensures CLI commands and flags are properly mapped to MCP tools.
 * Fails if a new CLI flag is added without a corresponding MCP tool.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  manifest,
  intentionallyNotExposed,
} from "../../../src/mcp/manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcRoot = join(__dirname, "../../../src");

let createProgram: () => Command;

describe("MCP drift test", () => {
  beforeAll(async () => {
    // Import src/index.ts for the commander tree without running the CLI or
    // touching the network (entry guards in src/index.ts). Removed right
    // after import: the guards evaluate at import time, and any CLI spawned
    // from this process must parse normally.
    process.env.VIBEFLOW_CLI_SKIP_PARSE = "1";
    process.env.VIBEFLOW_CLI_SKIP_REFRESH = "1";
    try {
      ({ createProgram } = await import("../../../src/index.js"));
    } finally {
      delete process.env.VIBEFLOW_CLI_SKIP_PARSE;
      delete process.env.VIBEFLOW_CLI_SKIP_REFRESH;
    }
  });

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

  it("all input schemas are zod raw shapes", () => {
    for (const tool of manifest) {
      // ZodRawShape is a plain object of { key: ZodType }
      expect(tool.input).toBeDefined();
      expect(typeof tool.input).toBe("object");
      for (const val of Object.values(tool.input)) {
        expect(typeof (val as { parse?: unknown }).parse).toBe("function");
      }
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

  it("the CLI program is introspectable without executing a command", () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual([
      "auth",
      "changelog",
      "kanban",
      "login",
      "logout",
      "push",
      "serve",
      "status",
      "tasks",
      "telemetry",
      "verify",
      "watch",
    ]);
    // A factory, not a singleton — each call builds a fresh tree.
    expect(createProgram()).not.toBe(program);
  });

  it("G1 coverage — every option on every subcommand is owned by a cliRef or explicitly not exposed", () => {
    const program = createProgram();
    // Owned = some tool's cliRef names the flag, scoped to the same command.
    const owned = new Set(
      manifest.flatMap((tool) =>
        tool.cliRef.flags.map((flag) => `${tool.cliRef.command} ${flag}`),
      ),
    );
    const unclassified: string[] = [];
    for (const cmd of program.commands) {
      const command = cmd.name();
      // A wholly-unexposed command is classified as a whole (§6.1).
      if (command in intentionallyNotExposed.commands) continue;
      for (const opt of cmd.options) {
        const flag = opt.long ?? opt.short;
        if (!flag || flag === "--help") continue; // framework artifact
        const key = `${command} ${flag}`;
        if (!owned.has(key) && !(key in intentionallyNotExposed.flags)) {
          unclassified.push(key);
        }
      }
    }
    expect(
      unclassified,
      `unclassified CLI flags — map each to a tool cliRef or give it a reason in intentionallyNotExposed: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("G1 classification — no stale intentionallyNotExposed entries", () => {
    const program = createProgram();
    const names = new Set(program.commands.map((c) => c.name()));
    for (const key of Object.keys(intentionallyNotExposed.commands)) {
      expect(
        names.has(key),
        `intentionallyNotExposed.commands lists "${key}", which is not a CLI command`,
      ).toBe(true);
    }
    for (const key of Object.keys(intentionallyNotExposed.flags)) {
      const sep = key.indexOf(" ");
      const command = key.slice(0, sep);
      const flag = key.slice(sep + 1);
      const cmd = program.commands.find((c) => c.name() === command);
      expect(
        cmd,
        `intentionallyNotExposed.flags key "${key}" names a nonexistent command`,
      ).toBeDefined();
      expect(
        cmd!.options.some((o) => o.long === flag),
        `intentionallyNotExposed.flags key "${key}" names a flag that no longer exists`,
      ).toBe(true);
    }
  });

  it("G1 reverse — every cliRef command exists and every cliRef flag exists on that command", () => {
    const program = createProgram();
    for (const tool of manifest) {
      const cmd = program.commands.find(
        (c) => c.name() === tool.cliRef.command,
      );
      expect(
        cmd,
        `${tool.name}: cliRef.command "${tool.cliRef.command}" is not a CLI command`,
      ).toBeDefined();
      for (const flag of tool.cliRef.flags) {
        // Commander stores `--no-parent` as an option with long ===
        // "--no-parent", and `--get`/`--edit` as long options too, so
        // matching on `long` covers negatable and optional-arg flags.
        expect(
          cmd!.options.some((o) => o.long === flag),
          `${tool.name}: cliRef claims \`${tool.cliRef.command} ${flag}\`, which does not exist on that command`,
        ).toBe(true);
      }
    }
  });
});
