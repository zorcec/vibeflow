/**
 * Emit tests (ADR-0007): tool-scoped dispatch (scope.tool drives
 * discovery), action-scoped dedup (discarded per invocation, never
 * process-wide), envelope wiring, trust/precedence integration, and the
 * explicit kill-switch.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  createHookScope,
  emitAfterHook,
  resetShippedMissingWarning,
  resolveHookActor,
  resolveHookBoardId,
} from "../../../src/core/hooks/emit.js";
import { resetUnrunnableHookWarnings } from "../../../src/core/hooks/discover.js";

let projectDir: string;
let home: string;

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: "",
  VIBEFLOW_HOOKS: "1",
};

/** The repo's real committed defaults — the shipped root for fallback assertions. */
const SRC_DEFAULTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "src",
  "core",
  "hooks",
  "defaults",
);

const shippedOpts = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  home,
  shippedDir: SRC_DEFAULTS,
  ...extra,
});

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "hook-emit-proj-"));
  home = mkdtempSync(join(tmpdir(), "hook-emit-home-"));
  BASE_ENV.HOME = home;
  resetUnrunnableHookWarnings();
  resetShippedMissingWarning();
});

function hooksDir(root: string = projectDir): string {
  const dir = join(root, ".vibeflow-hooks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeProjectHook(tool = "tasks", body?: string): string {
  const dir = hooksDir();
  const file = join(dir, `${tool}.after.mjs`);
  writeFileSync(
    file,
    body ??
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:"scoped:"+JSON.parse(s).tool}))});`,
  );
  return file;
}

describe("emitAfterHook", () => {
  it("returns [] when the kill-switch is set (explicit, never silent fallback)", async () => {
    writeProjectHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      {
        ...(shippedOpts() as { home: string; shippedDir: string }),
        env: { ...BASE_ENV, VIBEFLOW_HOOKS: "0", VIBEFLOW_TRUST_HOOKS: "1" },
      },
    );
    expect(out).toEqual([]);
  });

  it("returns [] inside a hook (VIBEFLOW_IN_HOOK=1): nested writes work, nested hooks do not", async () => {
    writeProjectHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      {
        ...(shippedOpts() as { home: string; shippedDir: string }),
        env: { ...BASE_ENV, VIBEFLOW_IN_HOOK: "1", VIBEFLOW_TRUST_HOOKS: "1" },
      },
    );
    expect(out).toEqual([]);
  });

  it("runs a trusted project hook and returns its instructions", async () => {
    writeProjectHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      {
        ...(shippedOpts() as { home: string; shippedDir: string }),
        env: { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" },
      },
    );
    expect(out).toEqual(["scoped:tasks"]);
  });

  it("scope.tool drives discovery: a kanban.after.mjs never runs for tasks", async () => {
    writeProjectHook(
      "kanban",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({instructions:"wrong-tool"}))});`,
    );
    // tasks scope: the kanban file must NOT run (and no shipped task
    // default either — shippedDir is empty here).
    const emptyShipped = mkdtempSync(join(tmpdir(), "hook-emit-empty-shipped-"));
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope({ tool: "tasks", surface: "cli" }),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { home, shippedDir: emptyShipped, env: { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" } },
    );
    expect(out).toEqual([]);
    // kanban scope: the same file runs.
    const kanbanOut = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope({ tool: "kanban", surface: "cli" }),
      null,
      null,
      {
        home,
        shippedDir: emptyShipped,
        env: { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" },
      },
      { activityObject: { url: "http://localhost:3700" } },
    );
    expect(kanbanOut).toEqual(["wrong-tool"]);
  });

  it("dedups the same effect within one action scope", async () => {
    writeProjectHook();
    const env = { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" };
    const scope = createHookScope();
    const first = await emitAfterHook(
      { projectDir, mode: "local" },
      scope,
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { ...(shippedOpts() as { home: string; shippedDir: string }), env },
    );
    const second = await emitAfterHook(
      { projectDir, mode: "local" },
      scope,
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { ...(shippedOpts() as { home: string; shippedDir: string }), env },
    );
    expect(first).toEqual(["scoped:tasks"]);
    expect(second).toEqual([]);
  });

  it("repeated same-task actions in one process BOTH run (scopes are per-action)", async () => {
    writeProjectHook();
    const env = { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" };
    const ctx = { projectDir, mode: "local" } as const;
    const payload = { taskId: "abc", changed: ["status"] } as const;
    const first = await emitAfterHook(ctx, createHookScope(), "task.update", payload, {
      ...(shippedOpts() as { home: string; shippedDir: string }),
      env,
    });
    const second = await emitAfterHook(ctx, createHookScope(), "task.update", payload, {
      ...(shippedOpts() as { home: string; shippedDir: string }),
      env,
    });
    expect(first).toEqual(["scoped:tasks"]);
    expect(second).toEqual(["scoped:tasks"]);
  });

  it("different activities in one scope both run (no cross-activity suppression)", async () => {
    writeProjectHook(
      "tasks",
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify({instructions:"saw:"+e.activity}))});`,
    );
    const env = { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" };
    const ctx = { projectDir, mode: "local" } as const;
    const scope = createHookScope();
    const update = await emitAfterHook(ctx, scope, "task.update", { taskId: "a", changed: ["title"] }, { ...(shippedOpts() as { home: string; shippedDir: string }), env });
    const comment = await emitAfterHook(
      ctx,
      scope,
      "task.comment",
      { taskId: "a", commentId: "c1" },
      { ...(shippedOpts() as { home: string; shippedDir: string }), env },
    );
    expect(update).toEqual(["saw:task.update"]);
    expect(comment).toEqual(["saw:task.comment"]);
  });

  it("failed hooks resolve to [] (fail-open, values not throws)", async () => {
    writeProjectHook(
      "tasks",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("garbage")});`,
    );
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.delete",
      { taskId: "abc", childCount: 0 },
      {
        ...(shippedOpts() as { home: string; shippedDir: string }),
        env: { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" },
      },
    );
    expect(out).toEqual([]);
  });

  it("untrusted project hooks do not run and say why (non-TTY)", async () => {
    writeProjectHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      {
        ...(shippedOpts() as { home: string; shippedDir: string }),
        env: { ...BASE_ENV },
      },
    );
    expect(out).toEqual([]);
  });

  it("falls back to shipped defaults (unconditional text) when nothing overrides", async () => {
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { ...(shippedOpts() as { home: string; shippedDir: string }), env: { ...BASE_ENV } },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('NEVER set status "done"');
  });

  it("a shipped file that symlinks out is refused (HOOK_SHIPPED_ESCAPED), not trusted", async () => {
    const outside = mkdtempSync(join(tmpdir(), "hook-emit-outside-"));
    const evil = join(outside, "evil.mjs");
    writeFileSync(evil, `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({instructions:"evil"}))});\n`);
    const tainted = mkdtempSync(join(tmpdir(), "hook-emit-tainted-"));
    const { symlinkSync: ln } = await import("node:fs");
    ln(evil, join(tainted, "tasks.after.mjs"));
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error intercept for assertion
    process.stderr.write = (c: string) => {
      lines.push(String(c));
      return true;
    };
    try {
      const out = await emitAfterHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { taskId: "abc", changed: ["status"] },
        { home, shippedDir: tainted, env: { ...BASE_ENV } },
      );
      expect(out).toEqual([]);
    } finally {
      process.stderr.write = orig;
    }
    expect(lines.join("")).toContain("HOOK_SHIPPED_ESCAPED");
  });

  it("resolves the actor: context user, then VIBEFLOW_ACTOR, then user", () => {
    expect(
      resolveHookActor({ projectDir, mode: "local", userId: "ada" }, BASE_ENV),
    ).toBe("ada");
    expect(
      resolveHookActor({ projectDir, mode: "local" }, { ...BASE_ENV, VIBEFLOW_ACTOR: "bot" }),
    ).toBe("bot");
    expect(
      resolveHookActor(
        { projectDir, mode: "local" },
        { ...BASE_ENV, USER: "u", USERNAME: undefined } as NodeJS.ProcessEnv,
      ),
    ).toBe("u");
  });

  it("resolves boardId null locally", () => {
    expect(resolveHookBoardId({ projectDir, mode: "local" })).toBeNull();
  });

  it("threads tool/surface/task/activityObject/instructions extras into the hook envelope", async () => {
    writeProjectHook(
      "tasks",
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify({instructions:JSON.stringify({tool:e.tool,surface:e.surface,activity:e.activity,task:e.task,activityObject:e.activityObject,instructions:e.instructions,payload:e.payload})}))});`,
    );
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope({ tool: "tasks", surface: "cli" }),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      {
        ...(shippedOpts() as { home: string; shippedDir: string }),
        env: { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" },
      },
      {
        task: { id: "abc", title: "t", status: "in-progress" },
        activityObject: { changed: ["status"] },
        instructions: "draft",
      },
    );
    expect(out).toHaveLength(1);
    const seen = JSON.parse(out[0]);
    // The legacy payload is byte-identical; the generic fields arrive
    // alongside it.
    expect(seen.tool).toBe("tasks");
    expect(seen.surface).toBe("cli");
    expect(seen.activity).toBe("task.update");
    expect(seen.payload).toEqual({ taskId: "abc", changed: ["status"] });
    expect(seen.task).toEqual({ id: "abc", title: "t", status: "in-progress" });
    expect(seen.activityObject).toEqual({ changed: ["status"] });
    expect(seen.instructions).toBe("draft");
  });

  it("defaults to task:null with no activityObject when no extras are passed", async () => {
    writeProjectHook(
      "push",
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify({instructions:JSON.stringify({tool:e.tool,task:e.task,hasActivity:"activityObject" in e,instructions:e.instructions})}))});`,
    );
    const out = await emitAfterHook(
      { projectDir, mode: "saas" },
      createHookScope({ tool: "push", surface: "cli" }),
      "push",
      { taskCount: 1, chunkCount: 1, transport: "remote" },
      {
        ...(shippedOpts() as { home: string; shippedDir: string }),
        env: { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" },
      },
    );
    expect(out).toHaveLength(1);
    const seen = JSON.parse(out[0]);
    expect(seen.tool).toBe("push");
    expect(seen.task).toBeNull();
    expect(seen.hasActivity).toBe(false);
    expect(seen.instructions).toBe("");
  });
});

describe("module peers (kept from v1, flat names)", () => {
  function writeProjectModuleHook(tool = "tasks", body?: string): string {
    const dir = hooksDir();
    const file = join(dir, `${tool}.after.hook.mjs`);
    writeFileSync(
      file,
      body ?? `export default async (envelope) => ({ instructions: "module:" + envelope.tool });`,
    );
    return file;
  }

  function writeGlobalStdioHook(tool = "tasks", instructions = "global-ok"): string {
    const dir = join(home, ".vibeflow", "hooks");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${tool}.after.mjs`);
    writeFileSync(
      file,
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:${JSON.stringify(instructions)}}))});`,
    );
    return file;
  }

  function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error intercept for assertion
    process.stderr.write = (c: string) => {
      lines.push(String(c));
      return true;
    };
    return { lines, restore: () => (process.stderr.write = orig) };
  }

  const TRUSTED_ENV = { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" };

  it("runs a trusted module hook and returns its instructions (fails if mode is ignored)", async () => {
    // Non-vacuity: spawning the `.hook.mjs` directly (stdio mode) would run
    // no protocol and yield HOOK_BAD_OUTPUT → []. Only the loader path
    // returns the instruction.
    writeProjectModuleHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { ...(shippedOpts() as { home: string; shippedDir: string }), env: TRUSTED_ENV },
    );
    expect(out).toEqual(["module:tasks"]);
  });

  it("project module beats global stdio (first level wins)", async () => {
    writeProjectModuleHook();
    writeGlobalStdioHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { ...(shippedOpts() as { home: string; shippedDir: string }), env: TRUSTED_ENV },
    );
    expect(out).toEqual(["module:tasks"]);
  });

  it("same-level conflict fails open with HOOK_CONFIG_CONFLICT and no lower-level default", async () => {
    writeProjectHook(
      "tasks",
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:"must not run"}))});`,
    );
    writeProjectModuleHook("tasks", `export default async () => ({ instructions: "must not run" });`);
    const { lines, restore } = captureStderr();
    try {
      const out = await emitAfterHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { taskId: "abc", changed: ["status"] },
        { ...(shippedOpts() as { home: string; shippedDir: string }), env: TRUSTED_ENV },
      );
      expect(out).toEqual([]);
    } finally {
      restore();
    }
    const stderr = lines.join("");
    expect(stderr).toContain("HOOK_CONFIG_CONFLICT");
    // No shipped-default fallback either: the unconditional update text
    // must not ride along after a conflict.
    expect(stderr).not.toContain('NEVER set status "done"');
  });

  it("a failing module hook never falls back to a lower level (single spawn, no retry)", async () => {
    const marker = join(projectDir, "marker.log");
    writeProjectModuleHook(
      "tasks",
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "spawn\\n");\nprocess.exit(3);\n`,
    );
    writeGlobalStdioHook();
    const { lines, restore } = captureStderr();
    try {
      const out = await emitAfterHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { taskId: "abc", changed: ["status"] },
        { ...(shippedOpts() as { home: string; shippedDir: string }), env: TRUSTED_ENV },
      );
      expect(out).toEqual([]);
    } finally {
      restore();
    }
    expect(lines.join("")).toContain("HOOK_NONZERO_EXIT");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8")).toBe("spawn\n");
  });

  it("an untrusted module hook does not fall back to global stdio", async () => {
    writeProjectModuleHook();
    writeGlobalStdioHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      // No VIBEFLOW_TRUST_HOOKS: non-TTY cannot prompt → refused.
      { ...(shippedOpts() as { home: string; shippedDir: string }), env: { ...BASE_ENV } },
    );
    expect(out).toEqual([]);
  });

  it("a changed-hash module hook does not fall back (stale trust record)", async () => {
    const { recordTrust } = await import("../../../src/core/hooks/trust.js");
    const file = writeProjectModuleHook();
    recordTrust(home, file, "stale-digest");
    writeGlobalStdioHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { ...(shippedOpts() as { home: string; shippedDir: string }), env: { ...BASE_ENV } },
    );
    expect(out).toEqual([]);
  });

  it("an escaped module hook does not fall back to global stdio", async () => {
    const { mkdtempSync: mkd } = await import("node:fs");
    const { symlinkSync: ln } = await import("node:fs");
    const outside = mkd(join(tmpdir(), "hook-emit-outside-"));
    const evil = join(outside, "evil.hook.mjs");
    writeFileSync(evil, `export default async () => ({ instructions: "evil" });\n`);
    const dir = hooksDir();
    ln(evil, join(dir, "tasks.after.hook.mjs"));
    writeGlobalStdioHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { ...(shippedOpts() as { home: string; shippedDir: string }), env: TRUSTED_ENV },
    );
    expect(out).toEqual([]);
  });

  it("repeated same-task module actions each execute (marker count 2)", async () => {
    const marker = join(projectDir, "count.log");
    writeProjectModuleHook(
      "tasks",
      `import { appendFileSync } from "node:fs";\nexport default async (envelope) => { appendFileSync(${JSON.stringify(marker)}, "run\\n"); return { instructions: "n:" + envelope.payload.taskId }; };\n`,
    );
    const ctx = { projectDir, mode: "local" } as const;
    const payload = { taskId: "abc", changed: ["status"] } as const;
    const first = await emitAfterHook(ctx, createHookScope(), "task.update", payload, {
      ...(shippedOpts() as { home: string; shippedDir: string }),
      env: TRUSTED_ENV,
    });
    const second = await emitAfterHook(ctx, createHookScope(), "task.update", payload, {
      ...(shippedOpts() as { home: string; shippedDir: string }),
      env: TRUSTED_ENV,
    });
    expect(first).toEqual(["n:abc"]);
    expect(second).toEqual(["n:abc"]);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8")).toBe("run\nrun\n");
  });
});

describe("TypeScript peers (kept from v1, flat names)", () => {
  function writeProjectTsHook(tool = "tasks", body?: string): string {
    const dir = hooksDir();
    const file = join(dir, `${tool}.after.hook.ts`);
    writeFileSync(
      file,
      body ??
        `import type { HookAfterResult } from "@vibeflow-tools/cli/hooks";\n` +
          `export default async (envelope: { activity: unknown }): Promise<HookAfterResult> => ({ instructions: "ts:" + String(envelope.activity) });\n`,
    );
    return file;
  }

  function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error intercept for assertion
    process.stderr.write = (c: string) => {
      lines.push(String(c));
      return true;
    };
    return { lines, restore: () => (process.stderr.write = orig) };
  }

  const TRUSTED_ENV = { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" };

  it("runs a trusted .hook.ts end to end (discovery, trust, strip, instructions)", async () => {
    writeProjectTsHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { ...(shippedOpts() as { home: string; shippedDir: string }), env: TRUSTED_ENV },
    );
    expect(out).toEqual(["ts:task.update"]);
  });

  it("a stdio+.hook.ts same-level conflict fails open and names every file", async () => {
    const dir = hooksDir();
    writeFileSync(join(dir, "tasks.after.mjs"), `// stdio\n`);
    const tsFile = writeProjectTsHook();
    const { lines, restore } = captureStderr();
    try {
      const out = await emitAfterHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { taskId: "abc", changed: ["status"] },
        { ...(shippedOpts() as { home: string; shippedDir: string }), env: TRUSTED_ENV },
      );
      expect(out).toEqual([]);
    } finally {
      restore();
    }
    const stderr = lines.join("");
    expect(stderr).toContain("HOOK_CONFIG_CONFLICT");
    expect(stderr).toContain(tsFile);
    expect(stderr).toContain("tasks.after.mjs");
  });
});
