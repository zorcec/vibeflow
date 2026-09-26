/**
 * G2 surface agreement — two INDEPENDENT views of the CLI flag inventory:
 *
 *  view 1: the live commander objects — src/index.ts `createProgram()`,
 *          dynamic-imported with VIBEFLOW_CLI_SKIP_PARSE=1 so no command
 *          runs and no network is touched;
 *  view 2: the rendered `--help` text of the BUILT, minified dist/index.js
 *          (mcp-helpers runCli).
 *
 * If the views disagree, a flag is registered in code but not rendered (or
 * vice versa), a command was renamed in only one place, or dist is stale.
 *
 * IMPORTANT: rebuild (`pnpm --filter @vibeflow-tools/cli run build`) before
 * running this suite — view 2 reads dist/index.js, and failing on a stale
 * dist is intentional.
 *
 * Textual-parsing note (plan §11.3): the regex matches option LONG names
 * only, per line, never short flags (`-p`), and both views filter the
 * commander framework's implicit `--help`.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Command } from "commander";
import { runCli } from "./mcp-helpers.js";

const COMMANDS = [
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
];

let createProgram: () => Command;

beforeAll(async () => {
  // Import for introspection, then remove the guards immediately: runCli
  // spreads process.env into the spawned CLI, and a leftover SKIP_PARSE
  // would make every later spawn a silent no-op. The guards are evaluated
  // once, at import time, so deleting them afterwards is safe.
  process.env.VIBEFLOW_CLI_SKIP_PARSE = "1";
  process.env.VIBEFLOW_CLI_SKIP_REFRESH = "1";
  try {
    ({ createProgram } = await import("../../src/index.js"));
  } finally {
    delete process.env.VIBEFLOW_CLI_SKIP_PARSE;
    delete process.env.VIBEFLOW_CLI_SKIP_REFRESH;
  }
});

describe("G2 — two independent views of the CLI surface", () => {
  it("G2 — commander introspection and `--help` agree on every subcommand's flag set", async () => {
    // ── view 1: live commander tree (source) ─────────────────────────────
    const program = createProgram();
    const view1 = new Map<string, Set<string>>();
    for (const cmd of program.commands) {
      const flags = new Set(
        cmd.options
          .map((o) => o.long)
          .filter((l): l is string => Boolean(l) && l !== "--help"),
      );
      view1.set(cmd.name(), flags);
    }
    expect([...view1.keys()].sort()).toEqual(COMMANDS);

    // ── view 2: rendered --help of the built binary ──────────────────────
    const home = mkdtempSync(join(tmpdir(), "mcp-surface-home-"));
    const view2Names = new Set<string>();
    for (const name of COMMANDS) {
      const res = await runCli([name, "--help"], { cwd: home, home });
      expect(res.code, `${name} --help failed: ${res.stderr}`).toBe(0);

      // Command-name view: derive from the Usage line, not from what we
      // asked for — an unknown command would have failed above.
      const usage = res.stdout.match(/^Usage: vibeflow (\S+)/m);
      expect(usage, `${name} --help has no "Usage: vibeflow <cmd>" line`).toBeTruthy();
      view2Names.add(usage![1]);

      const helpFlags = new Set(
        [...res.stdout.matchAll(/--[a-z][a-z0-9-]*/g)]
          .map((m) => m[0])
          .filter((f) => f !== "--help"),
      );
      const v1 = view1.get(name)!;
      const onlyCommander = [...v1].filter((f) => !helpFlags.has(f)).sort();
      const onlyHelp = [...helpFlags].filter((f) => !v1.has(f)).sort();
      expect(
        onlyCommander,
        `${name}: flag(s) in the commander tree but missing from the built binary's --help (stale dist?): ${onlyCommander.join(", ")}`,
      ).toEqual([]);
      expect(
        onlyHelp,
        `${name}: flag(s) rendered in --help but absent from the commander tree: ${onlyHelp.join(", ")}`,
      ).toEqual([]);
    }

    expect([...view2Names].sort()).toEqual([...view1.keys()].sort());
  });
});
