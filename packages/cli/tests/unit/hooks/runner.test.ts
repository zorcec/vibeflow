/**
 * Runner tests (ADR-0006): child-process only, fail-open after-hooks,
 * per-invocation deadline, byte limits, env allowlist, reentrancy guard,
 * stdout purity, and the complete result schemas.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HOOK_GUARD_ENV,
  HOOK_INVOCATION_TIMEOUT_MS,
  HOOK_MAX_OUTPUT_BYTES,
  parseAfterHookOutput,
  runAfterHook,
} from "../../../src/core/hooks/runner.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-runner-test-"));
});

function writeHook(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

/** A quiet env for spawning: real PATH/HOME, nothing else leaks in. */
function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...extra,
  };
}

describe("parseAfterHookOutput (complete result schemas)", () => {
  it("accepts {instructions:string}", () => {
    expect(parseAfterHookOutput('{"instructions":"do x"}')).toEqual({
      ok: true,
      instructions: "do x",
    });
  });

  it("accepts the {} no-op", () => {
    expect(parseAfterHookOutput("{}")).toEqual({ ok: true });
  });

  it("rejects empty stdout, malformed JSON, arrays, and wrong shapes", () => {
    expect(parseAfterHookOutput("")).toEqual({
      ok: false,
      reason: "HOOK_BAD_OUTPUT",
    });
    expect(parseAfterHookOutput("not json")).toEqual({
      ok: false,
      reason: "HOOK_BAD_OUTPUT",
    });
    expect(parseAfterHookOutput("[]")).toEqual({
      ok: false,
      reason: "HOOK_BAD_OUTPUT",
    });
    expect(parseAfterHookOutput("null")).toEqual({
      ok: false,
      reason: "HOOK_BAD_OUTPUT",
    });
    // Extra keys are not a shape we accept — never coerced.
    expect(parseAfterHookOutput('{"instructions":"x","extra":1}')).toEqual({
      ok: false,
      reason: "HOOK_BAD_OUTPUT",
    });
  });

  it("rejects non-string instructions (undefined/malformed/unserializable)", () => {
    expect(parseAfterHookOutput('{"instructions":42}')).toEqual({
      ok: false,
      reason: "HOOK_BAD_OUTPUT",
    });
    expect(parseAfterHookOutput('{"instructions":null}')).toEqual({
      ok: false,
      reason: "HOOK_BAD_OUTPUT",
    });
    expect(parseAfterHookOutput('{"instructions":{}}')).toEqual({
      ok: false,
      reason: "HOOK_BAD_OUTPUT",
    });
  });

  it("treats empty-string instructions as a no-op", () => {
    expect(parseAfterHookOutput('{"instructions":""}')).toEqual({ ok: true });
  });
});

describe("runAfterHook", () => {
  it("deadline is 2s per invocation", () => {
    expect(HOOK_INVOCATION_TIMEOUT_MS).toBe(2000);
  });

  it("does not spawn when already inside a hook (VIBEFLOW_IN_HOOK=1)", async () => {
    const file = writeHook("never.mjs", `process.exit(99);`);
    const result = await runAfterHook("task.update", file, "{}", {
      cwd: dir,
      env: testEnv({ [HOOK_GUARD_ENV]: "1" }),
    });
    expect(result).toEqual({ ran: false, reason: "HOOK_REENTRANT" });
  });

  it("returns instructions on success", async () => {
    const file = writeHook(
      "ok.mjs",
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:"link the SHA"}))});`,
    );
    const result = await runAfterHook(
      "task.update",
      file,
      JSON.stringify({ event: "task.update" }),
      { cwd: dir, env: testEnv() },
    );
    expect(result).toEqual({ ran: true, instructions: "link the SHA" });
  });

  it("treats {} as ran with no instructions", async () => {
    const file = writeHook(
      "noop.mjs",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("{}")});`,
    );
    const result = await runAfterHook("pull", file, "{}", {
      cwd: dir,
      env: testEnv(),
    });
    expect(result).toEqual({ ran: true, instructions: undefined });
  });

  it("fails open on non-zero exit (HOOK_NONZERO_EXIT)", async () => {
    const file = writeHook("boom.mjs", `process.exit(3);`);
    const errLines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error intercept for assertion
    process.stderr.write = (c: string) => {
      errLines.push(String(c));
      return true;
    };
    try {
      const result = await runAfterHook("push", file, "{}", {
        cwd: dir,
        env: testEnv(),
      });
      expect(result).toEqual({ ran: false, reason: "HOOK_NONZERO_EXIT" });
    } finally {
      process.stderr.write = orig;
    }
    expect(errLines.join("")).toContain("HOOK_NONZERO_EXIT");
  });

  it("fails open on non-JSON stdout (HOOK_BAD_OUTPUT)", async () => {
    const file = writeHook(
      "chatty.mjs",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("hello agent")});`,
    );
    const result = await runAfterHook("verify", file, "{}", {
      cwd: dir,
      env: testEnv(),
    });
    expect(result).toEqual({ ran: false, reason: "HOOK_BAD_OUTPUT" });
  });

  it("SIGKILLs on timeout so the parent settles within the deadline", async () => {
    // Holds stdout open forever — without tree cleanup the close event
    // would never fire and the parent would hang past the deadline.
    const file = writeHook(
      "hang.mjs",
      `process.stdin.resume();setInterval(()=>{},1000);`,
    );
    const start = Date.now();
    const result = await runAfterHook("task.comment", file, "{}", {
      cwd: dir,
      env: testEnv(),
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;
    expect(result).toEqual({ ran: false, reason: "HOOK_TIMEOUT" });
    expect(elapsed).toBeLessThan(5000);
  });

  it("enforces stdout byte limits (HOOK_OUTPUT_LIMIT)", async () => {
    const file = writeHook(
      "flood.mjs",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("x".repeat(100000))});`,
    );
    const result = await runAfterHook("task.delete", file, "{}", {
      cwd: dir,
      env: testEnv(),
      maxBytes: 1024,
    });
    expect(result).toEqual({ ran: false, reason: "HOOK_OUTPUT_LIMIT" });
  });

  it("default byte limit is 1 MiB", () => {
    expect(HOOK_MAX_OUTPUT_BYTES).toBe(1024 * 1024);
  });

  it("child env allowlist: PATH+HOME+guard only, never the caller's secrets", async () => {
    const file = writeHook(
      "env.mjs",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({instructions:JSON.stringify(process.env)}))});`,
    );
    const result = await runAfterHook("task.create", file, "{}", {
      cwd: dir,
      env: testEnv({ SECRET_SHOULD_NOT_LEAK: "s3cr3t" }),
    });
    expect(result.ran).toBe(true);
    const childEnv = JSON.parse(result.instructions ?? "{}") as Record<string, string>;
    expect(childEnv["SECRET_SHOULD_NOT_LEAK"]).toBeUndefined();
    expect(childEnv["VIBEFLOW_API_TOKEN"]).toBeUndefined();
    expect(childEnv[HOOK_GUARD_ENV]).toBe("1");
    expect(typeof childEnv["PATH"]).toBe("string");
    expect(typeof childEnv["HOME"]).toBe("string");
    expect(Object.keys(childEnv).sort()).toEqual(
      ["HOME", "PATH", HOOK_GUARD_ENV].sort(),
    );
  });

  it("passes stderr through prefixed and never writes parent stdout", async () => {
    const file = writeHook(
      "loud.mjs",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stderr.write("a note");process.stdout.write("{}")});`,
    );
    const errLines: string[] = [];
    const outLines: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    // @ts-expect-error intercept for assertion
    process.stderr.write = (c: string) => {
      errLines.push(String(c));
      return true;
    };
    // @ts-expect-error intercept for assertion
    process.stdout.write = (c: string) => {
      outLines.push(String(c));
      return true;
    };
    try {
      const result = await runAfterHook("task.claim", file, "{}", {
        cwd: dir,
        env: testEnv(),
      });
      expect(result.ran).toBe(true);
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }
    expect(errLines.join("")).toContain("hook task.claim: a note");
    expect(outLines.join("")).toBe("");
  });
});

describe("runAfterHook module mode (Stage 1.5, ADR-0006)", () => {
  function writeModuleHook(name: string, body: string): string {
    return writeHook(name, body);
  }

  const ENVELOPE = JSON.stringify({
    schemaVersion: 1,
    event: "task.update",
    phase: "after",
    boardId: null,
    actor: "tester",
    ts: "2026-11-05T00:00:00.000Z",
    payload: { taskId: "abc", changed: ["status"] },
  });

  function moduleOpts(extra: Record<string, unknown> = {}): {
    cwd: string;
    env: NodeJS.ProcessEnv;
    mode: "module";
  } {
    return { cwd: dir, env: testEnv(), mode: "module", ...extra };
  }

  it("runs sync and async default exports with the full envelope", async () => {
    const sync = writeModuleHook(
      "mod-sync.hook.mjs",
      `export default (envelope) => ({ instructions: [envelope.event, envelope.phase, envelope.payload.taskId, envelope.actor].join(":") });`,
    );
    const first = await runAfterHook("task.update", sync, ENVELOPE, moduleOpts());
    expect(first).toEqual({ ran: true, instructions: "task.update:after:abc:tester" });

    const asyncHook = writeModuleHook(
      "mod-async.hook.mjs",
      `export default async (envelope) => ({ instructions: "async:" + envelope.payload.changed.join(",") });`,
    );
    const second = await runAfterHook("task.update", asyncHook, ENVELOPE, moduleOpts());
    expect(second).toEqual({ ran: true, instructions: "async:status" });
  });

  it("treats {} as ran with no instructions", async () => {
    const file = writeModuleHook("mod-noop.hook.mjs", `export default () => ({});`);
    const result = await runAfterHook("pull", file, ENVELOPE, moduleOpts());
    expect(result).toEqual({ ran: true, instructions: undefined });
  });

  it("rejects missing/non-callable default exports (HOOK_NONZERO_EXIT)", async () => {
    const named = writeModuleHook("mod-named.hook.mjs", `export const x = 1;`);
    expect(await runAfterHook("push", named, ENVELOPE, moduleOpts())).toEqual({
      ran: false,
      reason: "HOOK_NONZERO_EXIT",
    });
    const value = writeModuleHook("mod-value.hook.mjs", `export default 42;`);
    expect(await runAfterHook("push", value, ENVELOPE, moduleOpts())).toEqual({
      ran: false,
      reason: "HOOK_NONZERO_EXIT",
    });
  });

  it("rejects import syntax errors and handler rejections (HOOK_NONZERO_EXIT)", async () => {
    const syntax = writeModuleHook("mod-syntax.hook.mjs", `export default ( => ;`);
    expect(await runAfterHook("push", syntax, ENVELOPE, moduleOpts())).toEqual({
      ran: false,
      reason: "HOOK_NONZERO_EXIT",
    });
    const reject = writeModuleHook(
      "mod-reject.hook.mjs",
      `export default async () => { throw new Error("nope"); };`,
    );
    expect(await runAfterHook("push", reject, ENVELOPE, moduleOpts())).toEqual({
      ran: false,
      reason: "HOOK_NONZERO_EXIT",
    });
  });

  it("rejects undefined returns as HOOK_NONZERO_EXIT (never a silent no-op)", async () => {
    const file = writeModuleHook("mod-undef.hook.mjs", `export default () => undefined;`);
    expect(await runAfterHook("task.update", file, ENVELOPE, moduleOpts())).toEqual({
      ran: false,
      reason: "HOOK_NONZERO_EXIT",
    });
  });

  it("rejects wrong-typed returns via the shared parser (HOOK_BAD_OUTPUT)", async () => {
    for (const [name, body] of [
      ["mod-num.hook.mjs", `export default () => 42;`],
      ["mod-arr.hook.mjs", `export default () => [];`],
      ["mod-extra.hook.mjs", `export default () => ({ instructions: "x", extra: 1 });`],
    ] as Array<[string, string]>) {
      const file = writeModuleHook(name, body);
      expect(await runAfterHook("task.update", file, ENVELOPE, moduleOpts())).toEqual({
        ran: false,
        reason: "HOOK_BAD_OUTPUT",
      });
    }
  });

  it("rejects circular and BigInt returns (HOOK_NONZERO_EXIT)", async () => {
    const circular = writeModuleHook(
      "mod-circ.hook.mjs",
      `export default () => { const o = {}; o.self = o; return o; };`,
    );
    expect(await runAfterHook("push", circular, ENVELOPE, moduleOpts())).toEqual({
      ran: false,
      reason: "HOOK_NONZERO_EXIT",
    });
    const big = writeModuleHook("mod-big.hook.mjs", `export default () => 10n;`);
    expect(await runAfterHook("push", big, ENVELOPE, moduleOpts())).toEqual({
      ran: false,
      reason: "HOOK_NONZERO_EXIT",
    });
  });

  it("rejects import-time console.log as HOOK_BAD_OUTPUT (never an instruction)", async () => {
    const file = writeModuleHook(
      "mod-chatty.hook.mjs",
      `console.log('{"fake":"protocol"}');\nexport default () => ({});`,
    );
    expect(await runAfterHook("verify", file, ENVELOPE, moduleOpts())).toEqual({
      ran: false,
      reason: "HOOK_BAD_OUTPUT",
    });
  });

  it("keeps stderr-only chatter on stderr and still runs", async () => {
    const file = writeModuleHook(
      "mod-loud.hook.mjs",
      `process.stderr.write("module note");\nexport default () => ({});`,
    );
    const errLines: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    // @ts-expect-error intercept for assertion
    process.stderr.write = (c: string) => {
      errLines.push(String(c));
      return true;
    };
    try {
      expect(await runAfterHook("task.claim", file, ENVELOPE, moduleOpts())).toEqual({
        ran: true,
        instructions: undefined,
      });
    } finally {
      process.stderr.write = origErr;
    }
    expect(errLines.join("")).toContain("hook task.claim: module note");
  });

  it("SIGKILLs a hung import/handler so the parent settles (HOOK_TIMEOUT)", async () => {
    const file = writeModuleHook(
      "mod-hang.hook.mjs",
      `await new Promise((resolve) => setTimeout(resolve, 60000));\nexport default () => ({});`,
    );
    const start = Date.now();
    const result = await runAfterHook("task.comment", file, ENVELOPE, moduleOpts({ timeoutMs: 300 }));
    expect(result).toEqual({ ran: false, reason: "HOOK_TIMEOUT" });
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("settles even when a descendant inherits the pipes (HOOK_TIMEOUT)", async () => {
    const file = writeModuleHook(
      "mod-pipes.hook.mjs",
      `import { spawn } from "node:child_process";\nspawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });\nawait new Promise(() => {});`,
    );
    const start = Date.now();
    const result = await runAfterHook("push", file, ENVELOPE, moduleOpts({ timeoutMs: 300 }));
    expect(result).toEqual({ ran: false, reason: "HOOK_TIMEOUT" });
    expect(Date.now() - start).toBeLessThan(8000);
  });

  it("enforces stdout byte limits in module mode (HOOK_OUTPUT_LIMIT, not timeout)", async () => {
    const file = writeModuleHook(
      "mod-flood.hook.mjs",
      `export default () => ({ instructions: "x".repeat(100000) });`,
    );
    const result = await runAfterHook("task.delete", file, ENVELOPE, moduleOpts({ maxBytes: 1024 }));
    expect(result).toEqual({ ran: false, reason: "HOOK_OUTPUT_LIMIT" });
  });

  it("resolves special-character hook paths (spaces, unicode, #, ?, %)", async () => {
    const { mkdirSync, writeFileSync: write } = await import("node:fs");
    const weird = join(dir, "dir with spaces señor #1?%");
    mkdirSync(weird, { recursive: true });
    const file = join(weird, "after-task.update.hook.mjs");
    write(file, `export default (envelope) => ({ instructions: "weird:" + envelope.event });\n`);
    const result = await runAfterHook("task.update", file, ENVELOPE, moduleOpts());
    expect(result).toEqual({ ran: true, instructions: "weird:task.update" });
  });

  it("module child env is the same allowlist (PATH+HOME+guard only)", async () => {
    const file = writeModuleHook(
      "mod-env.hook.mjs",
      `export default () => ({ instructions: JSON.stringify(process.env) });`,
    );
    const result = await runAfterHook(
      "task.create",
      file,
      ENVELOPE,
      moduleOpts({ env: testEnv({ SECRET_SHOULD_NOT_LEAK: "s3cr3t" }) }),
    );
    expect(result.ran).toBe(true);
    const childEnv = JSON.parse(result.instructions ?? "{}") as Record<string, string>;
    expect(childEnv["SECRET_SHOULD_NOT_LEAK"]).toBeUndefined();
    expect(childEnv[HOOK_GUARD_ENV]).toBe("1");
    expect(Object.keys(childEnv).sort()).toEqual(["HOME", "PATH", HOOK_GUARD_ENV].sort());
  });
});
