/**
 * Invocation boundary tests (ADR-0007, T5): one execution per (tool,
 * activity), exactly one null-activity execution for an effect-free
 * success, zero for failed/refused/dry-run, bypassed gates still run
 * the effect's after hook with no extra null-activity execution.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  beginToolInvocation,
  finishToolInvocation,
} from "../../../src/core/hooks/invocation.js";
import {
  createHookScope,
  emitAfterHook,
  emitBeforeHook,
  type EmitOptions,
} from "../../../src/core/hooks/emit.js";
import { resetUnrunnableHookWarnings } from "../../../src/core/hooks/discover.js";
import { resetShippedMissingWarning } from "../../../src/core/hooks/emit.js";

let projectDir: string;
let home: string;
let shippedDir: string;

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: "",
  VIBEFLOW_HOOKS: "1",
  VIBEFLOW_TRUST_HOOKS: "1",
};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "hook-inv-proj-"));
  home = mkdtempSync(join(tmpdir(), "hook-inv-home-"));
  shippedDir = mkdtempSync(join(tmpdir(), "hook-inv-shipped-"));
  BASE_ENV.HOME = home;
  resetUnrunnableHookWarnings();
  resetShippedMissingWarning();
});

const opts = (): EmitOptions => ({ home, shippedDir, env: { ...BASE_ENV } });

function writeHook(tool: string, phase: "before" | "after", body: string): string {
  const dir = join(projectDir, ".vibeflow-hooks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tool}.${phase}.mjs`);
  writeFileSync(file, body);
  return file;
}

const MARKER = (tool: string, activity: string): string =>
  `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify({instructions:${JSON.stringify(tool + ":" + activity)}}))});`;

describe("beginToolInvocation", () => {
  it("creates a scope keyed to the canonical tool", () => {
    const handle = beginToolInvocation({ tool: "tasks", surface: "cli" });
    expect(handle.tool).toBe("tasks");
    expect(handle.surface).toBe("cli");
    expect(handle.scope.tool).toBe("tasks");
  });

  it("unknown tools get a scope but never a hook (no throw, no crash)", async () => {
    // Probe/future tools keep working unhooked: the scanner reports
    // HOOK_UNKNOWN_TOOL for stray files and discovery simply misses.
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "frobnicate.after.mjs"), MARKER("t", "null"));
    const handle = beginToolInvocation({ tool: "frobnicate", surface: "cli" });
    expect(handle.tool).toBe("frobnicate");
    handle.target = { projectDir, mode: "local" };
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error intercept for assertion
    process.stderr.write = (c: string) => {
      lines.push(String(c));
      return true;
    };
    try {
      expect(await finishToolInvocation(handle, { ok: true }, opts())).toEqual([]);
    } finally {
      process.stderr.write = orig;
    }
    expect(lines.join("")).toContain("HOOK_UNKNOWN_TOOL");
  });
});

describe("finishToolInvocation", () => {
  it("fires exactly one null-activity after hook for an effect-free success", async () => {
    writeHook("tasks", "after", MARKER("t", "null"));
    const handle = beginToolInvocation({ tool: "tasks", surface: "cli" });
    handle.target = { projectDir, mode: "local" };
    const out = await finishToolInvocation(handle, { ok: true }, opts());
    expect(out).toHaveLength(1);
  });

  it("never double-fires: a second finish is a dedup no-op", async () => {
    writeHook("tasks", "after", MARKER("t", "null"));
    const handle = beginToolInvocation({ tool: "tasks", surface: "cli" });
    handle.target = { projectDir, mode: "local" };
    const first = await finishToolInvocation(handle, { ok: true }, opts());
    const second = await finishToolInvocation(handle, { ok: true }, opts());
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("fires zero hooks when the invocation failed (ok:false)", async () => {
    writeHook("tasks", "after", MARKER("t", "null"));
    const handle = beginToolInvocation({ tool: "tasks", surface: "cli" });
    handle.target = { projectDir, mode: "local" };
    expect(await finishToolInvocation(handle, { ok: false }, opts())).toEqual([]);
  });

  it("fires zero hooks for a dry-run (no emission without a confirmed effect)", async () => {
    writeHook("tasks", "after", MARKER("t", "null"));
    const handle = beginToolInvocation({ tool: "tasks", surface: "cli" });
    handle.target = { projectDir, mode: "local" };
    expect(await finishToolInvocation(handle, { ok: true, dryRun: true }, opts())).toEqual([]);
  });

  it("fires zero hooks with no target (body never resolved a root)", async () => {
    writeHook("tasks", "after", MARKER("t", "null"));
    const handle = beginToolInvocation({ tool: "tasks", surface: "cli" });
    expect(await finishToolInvocation(handle, { ok: true }, opts())).toEqual([]);
  });

  it("a recorded activity suppresses the null-activity execution (N activities ⇒ N runs, no +1)", async () => {
    writeHook(
      "tasks",
      "after",
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify({instructions:"saw:"+e.activity}))});`,
    );
    const handle = beginToolInvocation({ tool: "tasks", surface: "cli" });
    handle.target = { projectDir, mode: "local" };
    // One activity + one null-activity-capable invocation: the operation's
    // own emissions come first (2 runs), the boundary adds nothing.
    await emitAfterHook(
      { projectDir, mode: "local" },
      handle.scope,
      "task.update",
      { taskId: "a", changed: ["title"] },
      opts(),
    );
    await emitAfterHook(
      { projectDir, mode: "local" },
      handle.scope,
      "task.comment",
      { taskId: "a", commentId: "c1" },
      opts(),
    );
    // Marker: make finish always fire → this case fails (2 runs + 1).
    expect(await finishToolInvocation(handle, { ok: true }, opts())).toEqual([]);
    expect(handle.scope.seen.size).toBe(2);
  });

  it("a bypassed gate still runs the effect hook with no extra null-activity execution", async () => {
    writeHook(
      "tasks",
      "after",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({instructions:"effect"}))});`,
    );
    const handle = beginToolInvocation({ tool: "tasks", surface: "cli" });
    handle.target = { projectDir, mode: "local" };
    // Bypass the gate, then run the (bypassed) effect's after hook from
    // the operation — scope.seen is non-empty, so finish adds nothing.
    const gate = await emitBeforeHook(
      { projectDir, mode: "local" },
      handle.scope,
      "task.update",
      { payload: { taskId: "a", changed: ["t"] }, bypass: true, command: "tasks --edit" },
      opts(),
    );
    expect(gate.bypassed).toBe(true);
    const effect = await emitAfterHook(
      { projectDir, mode: "local" },
      handle.scope,
      "task.update",
      { taskId: "a", changed: ["t"] },
      opts(),
    );
    expect(effect).toEqual(["effect"]);
    expect(await finishToolInvocation(handle, { ok: true }, opts())).toEqual([]);
  });

  it("carries task/activityObject into the null-activity envelope", async () => {
    writeHook(
      "kanban",
      "after",
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify({instructions:JSON.stringify({activity:e.activity,task:e.task,activityObject:e.activityObject})}))});`,
    );
    const handle = beginToolInvocation({ tool: "kanban", surface: "cli" });
    handle.target = { projectDir, mode: "local" };
    const out = await finishToolInvocation(
      handle,
      { ok: true, activityObject: { url: "http://localhost:3700" } },
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toEqual({
      activity: null,
      task: null,
      activityObject: { url: "http://localhost:3700" },
    });
  });

  it("per-action scopes: two handles each fire once", async () => {
    writeHook("tasks", "after", MARKER("t", "null"));
    const first = beginToolInvocation({ tool: "tasks", surface: "cli" });
    first.target = { projectDir, mode: "local" };
    const second = beginToolInvocation({ tool: "tasks", surface: "cli" });
    second.target = { projectDir, mode: "local" };
    expect(await finishToolInvocation(first, { ok: true }, opts())).toHaveLength(1);
    expect(await finishToolInvocation(second, { ok: true }, opts())).toHaveLength(1);
    expect(first.scope).not.toBe(second.scope);
  });

  it("reentrancy and kill-switch flow through (nested invocations emit nothing)", async () => {
    writeHook("tasks", "after", MARKER("t", "null"));
    const handle = beginToolInvocation({ tool: "tasks", surface: "cli" });
    handle.target = { projectDir, mode: "local" };
    const out = await finishToolInvocation(handle, { ok: true }, {
      ...opts(),
      env: { ...BASE_ENV, VIBEFLOW_IN_HOOK: "1" },
    });
    expect(out).toEqual([]);
    expect(createHookScope().seen.size).toBe(0);
  });
});
