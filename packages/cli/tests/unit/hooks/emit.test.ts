/**
 * Emit tests (ADR-0006): the shared dispatch helper — action-scoped dedup
 * (discarded per invocation, never process-wide), envelope wiring,
 * trust/precedence integration, and the explicit kill-switch.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createHookScope,
  emitAfterHook,
  resolveHookActor,
  resolveHookBoardId,
} from "../../../src/core/hooks/emit.js";

let projectDir: string;
let home: string;

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: "",
  VIBEFLOW_HOOKS: "1",
};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "hook-emit-proj-"));
  home = mkdtempSync(join(tmpdir(), "hook-emit-home-"));
  BASE_ENV.HOME = home;
});

function writeProjectHook(event = "task.update", body?: string): string {
  const dir = join(projectDir, ".vibeflow-hooks", "after");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `after-${event}.mjs`);
  writeFileSync(
    file,
    body ??
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:"scoped:"+JSON.parse(s).event}))});`,
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
        home,
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
        home,
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
      { home, env: { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" } },
    );
    expect(out).toEqual(["scoped:task.update"]);
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
      { home, env },
    );
    const second = await emitAfterHook(
      { projectDir, mode: "local" },
      scope,
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { home, env },
    );
    expect(first).toEqual(["scoped:task.update"]);
    expect(second).toEqual([]);
  });

  it("repeated same-task actions in one process BOTH run (scopes are per-action)", async () => {
    writeProjectHook();
    const env = { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" };
    const ctx = { projectDir, mode: "local" } as const;
    const payload = { taskId: "abc", changed: ["status"] } as const;
    const first = await emitAfterHook(ctx, createHookScope(), "task.update", payload, {
      home,
      env,
    });
    const second = await emitAfterHook(ctx, createHookScope(), "task.update", payload, {
      home,
      env,
    });
    expect(first).toEqual(["scoped:task.update"]);
    expect(second).toEqual(["scoped:task.update"]);
  });

  it("different events in one scope both run (no cross-event suppression)", async () => {
    writeProjectHook("task.update");
    writeProjectHook(
      "task.comment",
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:"comment-ok"}))});`,
    );
    const env = { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" };
    const ctx = { projectDir, mode: "local" } as const;
    const scope = createHookScope();
    const update = await emitAfterHook(ctx, scope, "task.update", { taskId: "a", changed: ["title"] }, { home, env });
    const comment = await emitAfterHook(
      ctx,
      scope,
      "task.comment",
      { taskId: "a", commentId: "c1" },
      { home, env },
    );
    expect(update).toEqual(["scoped:task.update"]);
    expect(comment).toEqual(["comment-ok"]);
  });

  it("failed hooks resolve to [] (fail-open, values not throws)", async () => {
    writeProjectHook(
      "task.delete",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("garbage")});`,
    );
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.delete",
      { taskId: "abc", childCount: 0 },
      { home, env: { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: "1" } },
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
      { home, env: { ...BASE_ENV } },
    );
    expect(out).toEqual([]);
  });

  it("falls back to shipped defaults (unconditional text) when nothing overrides", async () => {
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { home, env: { ...BASE_ENV } },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('NEVER set a task status to "done"');
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
});

describe("module peers (Stage 1.5, ADR-0006)", () => {
  function writeProjectModuleHook(event = "task.update", body?: string): string {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `after-${event}.hook.mjs`);
    writeFileSync(
      file,
      body ?? `export default async (envelope) => ({ instructions: "module:" + envelope.event });`,
    );
    return file;
  }

  function writeGlobalStdioHook(event = "task.update", instructions = "global-ok"): string {
    const dir = join(home, ".vibeflow", "hooks", "after");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `after-${event}.mjs`);
    writeFileSync(
      file,
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:${JSON.stringify(instructions)}}))});`,
    );
    return file;
  }

  function captureStderr() {
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
      { home, env: TRUSTED_ENV },
    );
    expect(out).toEqual(["module:task.update"]);
  });

  it("project module beats global stdio (first level wins)", async () => {
    writeProjectModuleHook();
    writeGlobalStdioHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { home, env: TRUSTED_ENV },
    );
    expect(out).toEqual(["module:task.update"]);
  });

  it("same-level conflict fails open with HOOK_CONFIG_CONFLICT and no lower-level default", async () => {
    writeProjectHook(
      "task.update",
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:"must not run"}))});`,
    );
    writeProjectModuleHook("task.update", `export default async () => ({ instructions: "must not run" });`);
    const { lines, restore } = captureStderr();
    try {
      const out = await emitAfterHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { taskId: "abc", changed: ["status"] },
        { home, env: TRUSTED_ENV },
      );
      expect(out).toEqual([]);
    } finally {
      restore();
    }
    const stderr = lines.join("");
    expect(stderr).toContain("HOOK_CONFIG_CONFLICT");
    // No shipped-default fallback either: the unconditional update text
    // must not ride along after a conflict.
    expect(stderr).not.toContain('NEVER set a task status to "done"');
  });

  it("a failing module hook never falls back to a lower level (single spawn, no retry)", async () => {
    const marker = join(projectDir, "marker.log");
    writeProjectModuleHook(
      "task.update",
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
        { home, env: TRUSTED_ENV },
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
      { home, env: { ...BASE_ENV } },
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
      { home, env: { ...BASE_ENV } },
    );
    expect(out).toEqual([]);
  });

  it("an escaped module hook does not fall back to global stdio", async () => {
    const { mkdtempSync: mkd } = await import("node:fs");
    const { symlinkSync: ln } = await import("node:fs");
    const outside = mkd(join(tmpdir(), "hook-emit-outside-"));
    const evil = join(outside, "evil.hook.mjs");
    writeFileSync(evil, `export default async () => ({ instructions: "evil" });\n`);
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    ln(evil, join(dir, "after-task.update.hook.mjs"));
    writeGlobalStdioHook();
    const out = await emitAfterHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { taskId: "abc", changed: ["status"] },
      { home, env: TRUSTED_ENV },
    );
    expect(out).toEqual([]);
  });

  it("repeated same-task module actions each execute (marker count 2)", async () => {
    const marker = join(projectDir, "count.log");
    writeProjectModuleHook(
      "task.update",
      `import { appendFileSync } from "node:fs";\nexport default async (envelope) => { appendFileSync(${JSON.stringify(marker)}, "run\\n"); return { instructions: "n:" + envelope.payload.taskId }; };\n`,
    );
    const ctx = { projectDir, mode: "local" } as const;
    const payload = { taskId: "abc", changed: ["status"] } as const;
    const first = await emitAfterHook(ctx, createHookScope(), "task.update", payload, {
      home,
      env: TRUSTED_ENV,
    });
    const second = await emitAfterHook(ctx, createHookScope(), "task.update", payload, {
      home,
      env: TRUSTED_ENV,
    });
    expect(first).toEqual(["n:abc"]);
    expect(second).toEqual(["n:abc"]);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8")).toBe("run\nrun\n");
  });
});
