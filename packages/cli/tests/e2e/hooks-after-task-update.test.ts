/**
 * After-hook e2e (Stage 1, ADR-0006): a real CLI spawn with a trusted
 * project after-hook.
 * - `tasks --edit --json` success path = exactly ONE JSON doc on stdout,
 *   carrying `instructions` from the hook;
 * - stdout stays byte-clean (`JSON.parse` of the whole stream);
 * - an untrusted project hook does not run and says why on stderr.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCliIsolated } from "./spawn-isolated.js";
import { ensureTaskDirs } from "../../src/core/tasks.js";

let cliHome!: string;
let projectDir!: string;

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "hook-e2e-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "hook-e2e-proj-"));
  ensureTaskDirs(projectDir);
});

afterEach(() => {
  rmSync(cliHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const HOOK_ENV = { VIBEFLOW_HOOKS: "1", VIBEFLOW_TRUST_HOOKS: "1" };

async function addTask(): Promise<string> {
  const added = await spawnCliIsolated(
    ["tasks", "--add", "--title", "hook e2e task", "--json"],
    { cwd: projectDir, home: cliHome, env: HOOK_ENV },
  );
  expect(added.code).toBe(0);
  const doc = JSON.parse(added.stdout) as { task: { id: string } };
  return doc.task.id;
}

function writeProjectHook(body: string): void {
  const dir = join(projectDir, ".vibeflow-hooks", "after");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "after-task.update.mjs"), body);
}

describe("hooks-after-task-update e2e", () => {
  it("tasks --edit --json success = exactly ONE JSON doc carrying hook instructions", async () => {
    const id = await addTask();
    writeProjectHook(
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify({instructions:"hook saw "+e.event}));});`,
    );
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).toBe(0);
    // Exactly ONE JSON document on stdout — byte-clean for piping.
    const doc = JSON.parse(edited.stdout) as {
      ok: boolean;
      instructions?: string[];
    };
    expect(doc.ok).toBe(true);
    expect(doc.instructions).toEqual(["hook saw task.update"]);
  });

  it("an untrusted project hook does not run and says why", async () => {
    const id = await addTask();
    writeProjectHook(
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({instructions:"must not run"}))});`,
    );
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      // No VIBEFLOW_TRUST_HOOKS: non-TTY cannot prompt, so the hook is refused.
      { cwd: projectDir, home: cliHome, env: { VIBEFLOW_HOOKS: "1" } },
    );
    expect(edited.code).toBe(0);
    const doc = JSON.parse(edited.stdout) as {
      ok: boolean;
      instructions?: string[];
    };
    expect(doc.ok).toBe(true);
    expect(doc.instructions).toBeUndefined();
    expect(edited.stderr).toContain("non-interactive");
  });

  it("shipped defaults run with no project hook (unconditional text rides along)", async () => {
    const id = await addTask();
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).toBe(0);
    const doc = JSON.parse(edited.stdout) as {
      ok: boolean;
      instructions?: string[];
    };
    expect(doc.ok).toBe(true);
    // Shipped defaults ARE hooks: the unconditional update text rides along.
    expect(doc.instructions?.join("\n")).toContain(
      'NEVER set a task status to "done"',
    );
  });
});
