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
