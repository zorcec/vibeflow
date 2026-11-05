/**
 * Runtime-utility e2e (owner ticket c478fd86 item 3): a stdio project hook
 * that imports ONLY `process.env.VIBEFLOW_HOOK_RUNTIME` (no package-name
 * import — the npx/global case) and uses `readEnvelope()` + `reply()` +
 * `log()` plus `console.log`, run through the REAL packaged CLI
 * (`dist/index.js`, which ships `dist/hooks/hook-runtime.mjs`).
 * Proves: instructions surface in `--json`, stdout stays one JSON
 * document, and both console.log and log() land on stderr with the
 * `hook <tool>:` prefix.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCliIsolated } from "./spawn-isolated.js";
import { ensureTaskDirs } from "../../src/core/tasks.js";

let cliHome: string;
let projectDir: string;

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "hook-util-e2e-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "hook-util-e2e-proj-"));
  ensureTaskDirs(projectDir);
});

afterEach(() => {
  rmSync(cliHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const HOOK_ENV = { VIBEFLOW_HOOKS: "1", VIBEFLOW_TRUST_HOOKS: "1" };

/** Stdio hook with zero hand-rolled stdin/stdout boilerplate — the utility does it all. */
const UTILITY_HOOK_BODY = [
  `const { readEnvelope, reply, log } = await import(process.env.VIBEFLOW_HOOK_RUNTIME);`,
  `const envelope = await readEnvelope();`,
  `console.log("utility hook saw", envelope.activity);`,
  `log("utility stderr note");`,
  `if (envelope.activity === "task.create" || envelope.activity === "task.update") reply({ instructions: "runtime-utility-note" });`,
  `else reply({});`,
  ``,
].join("\n");

describe("shipped runtime utility e2e (VIBEFLOW_HOOK_RUNTIME)", () => {
  it("readEnvelope+reply through the packaged CLI: instructions in --json, one stdout doc, chatter on stderr", async () => {
    mkdirSync(join(projectDir, ".vibeflow-hooks"), { recursive: true });
    writeFileSync(
      join(projectDir, ".vibeflow-hooks", "tasks.after.mjs"),
      UTILITY_HOOK_BODY,
    );
    const added = await spawnCliIsolated(
      ["tasks", "--add", "--title", "utility hook task", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(added.code).toBe(0);
    // stdout is exactly one JSON document (console.log did not pollute it).
    const doc = JSON.parse(added.stdout) as { ok: boolean; instructions?: string[] };
    expect(doc.ok).toBe(true);
    expect(doc.instructions).toContain("runtime-utility-note");
    // Both console.log (child-side guard) and log() land on stderr prefixed.
    expect(added.stderr).toContain("hook tasks: utility hook saw task.create");
    expect(added.stderr).toContain("hook tasks: utility stderr note");
  });
});
