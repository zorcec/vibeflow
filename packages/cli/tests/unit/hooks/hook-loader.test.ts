/**
 * Loader tests (ADR-0006 Stage 1.5): the standalone `hook-loader.mjs`
 * child entry — default-export invocation, failure taxonomy, stdout
 * discipline, and special-character paths. The parent parser stays
 * authoritative: the loader prints the return value, `runner.ts` judges it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOADER = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/core/hooks/hook-loader.mjs",
);

const ENVELOPE = {
  schemaVersion: 1,
  event: "task.update",
  phase: "after",
  boardId: null,
  actor: "tester",
  ts: "2026-11-05T00:00:00.000Z",
  payload: { taskId: "abc", changed: ["status"] },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-loader-test-"));
});

function writeHook(name: string, body: string, atDir: string = dir): string {
  const file = join(atDir, name);
  writeFileSync(file, body);
  return file;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runLoader(hookFile: string, stdinText: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [LOADER, hookFile], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function runEnvelope(hookFile: string, envelope: unknown = ENVELOPE): Promise<RunResult> {
  return runLoader(hookFile, JSON.stringify(envelope));
}

describe("hook-loader", () => {
  it("invokes sync and async default exports with the full envelope", async () => {
    const sync = writeHook(
      "sync.hook.mjs",
      `export default (envelope) => ({ instructions: "sync:" + envelope.event + ":" + envelope.payload.taskId + ":" + envelope.actor });`,
    );
    const asyncHook = writeHook(
      "async.hook.mjs",
      `export default async (envelope) => ({ instructions: "async:" + envelope.phase });`,
    );
    const first = await runEnvelope(sync);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ instructions: "sync:task.update:abc:tester" });
    const second = await runEnvelope(asyncHook);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({ instructions: "async:after" });
  });

  it("prints the {} no-op verbatim", async () => {
    const file = writeHook("noop.hook.mjs", `export default () => ({});`);
    const result = await runEnvelope(file);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it("rejects a missing default export", async () => {
    const file = writeHook("named.hook.mjs", `export const handler = () => ({});`);
    const result = await runEnvelope(file);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HOOK_NO_DEFAULT_EXPORT");
    expect(result.stdout).toBe("");
  });

  it("rejects a non-callable default export", async () => {
    const file = writeHook("value.hook.mjs", `export default 42;`);
    const result = await runEnvelope(file);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HOOK_NO_DEFAULT_EXPORT");
  });

  it("type-strips a .hook.ts hook with erased annotations and type imports (Stage 4)", async () => {
    const file = writeHook(
      "typed.hook.ts",
      `import type { HookAfterResult } from "@vibeflow-tools/cli/hooks";\n` +
        `export default async (envelope: { event: string }): Promise<HookAfterResult> => ({ instructions: "stripped:" + envelope.event });\n`,
    );
    const result = await runEnvelope(file);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ instructions: "stripped:task.update" });
  });

  it("refuses non-erasable TypeScript syntax loudly (Stage 4, never half-runs)", async () => {
    const file = writeHook(
      "non-erasable.hook.ts",
      `enum Color { Red = "red" }\nexport default async () => ({ instructions: "must never run:" + Color.Red });\n`,
    );
    const result = await runEnvelope(file);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HOOK_IMPORT_FAILED");
    expect(result.stdout).toBe("");
  });

  it("rejects import syntax errors", async () => {
    const file = writeHook("syntax.hook.mjs", `export default ( => ;`);
    const result = await runEnvelope(file);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HOOK_IMPORT_FAILED");
  });

  it("rejects missing hook files", async () => {
    const result = await runEnvelope(join(dir, "absent.hook.mjs"));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HOOK_IMPORT_FAILED");
  });

  it("rejects top-level-await rejections", async () => {
    const file = writeHook("tla.hook.mjs", `await Promise.reject(new Error("tla boom"));\nexport default () => ({});`);
    const result = await runEnvelope(file);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HOOK_IMPORT_FAILED");
  });

  it("rejects handler rejections", async () => {
    const file = writeHook(
      "reject.hook.mjs",
      `export default async () => { throw new Error("handler boom"); };`,
    );
    const result = await runEnvelope(file);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HOOK_HANDLER_FAILED");
    expect(result.stderr).toContain("handler boom");
  });

  it("rejects undefined returns (not a no-op)", async () => {
    const file = writeHook("undef.hook.mjs", `export default () => undefined;`);
    const result = await runEnvelope(file);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HOOK_BAD_OUTPUT");
    expect(result.stdout).toBe("");
  });

  it("prints other JSON values for the parent parser to judge", async () => {
    const num = writeHook("num.hook.mjs", `export default () => 42;`);
    expect((await runEnvelope(num)).code).toBe(0);
    expect(JSON.parse((await runEnvelope(num)).stdout)).toBe(42);
    const arr = writeHook("arr.hook.mjs", `export default () => [];`);
    expect(JSON.parse((await runEnvelope(arr)).stdout)).toEqual([]);
    const extra = writeHook("extra.hook.mjs", `export default () => ({ instructions: "x", extra: 1 });`);
    expect(JSON.parse((await runEnvelope(extra)).stdout)).toEqual({
      instructions: "x",
      extra: 1,
    });
  });

  it("rejects circular and BigInt returns", async () => {
    const circular = writeHook(
      "circ.hook.mjs",
      `export default () => { const o = {}; o.self = o; return o; };`,
    );
    const circularResult = await runEnvelope(circular);
    expect(circularResult.code).not.toBe(0);
    expect(circularResult.stderr).toContain("HOOK_BAD_OUTPUT");
    const big = writeHook("big.hook.mjs", `export default () => 10n;`);
    const bigResult = await runEnvelope(big);
    expect(bigResult.code).not.toBe(0);
    expect(bigResult.stderr).toContain("HOOK_BAD_OUTPUT");
  });

  // Owner ticket c478fd86: import-time console.log is rerouted to stderr
  // by the loader-top guard, so stdout stays the single JSON document —
  // chatter can never become an instruction. Raw process.stdout.write
  // pollution is still the parent parser's HOOK_BAD_OUTPUT (pinned in
  // runner.test.ts).
  it("reroutes import-time console.log to stderr, stdout stays the single document", async () => {
    const file = writeHook(
      "chatty.hook.mjs",
      `console.log('{"fake":"protocol"}');\nexport default () => ({});`,
    );
    const result = await runEnvelope(file);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.stderr).toContain('{"fake":"protocol"}');
  });

  it("keeps stderr chatter on stderr, stdout to the single document", async () => {
    const file = writeHook(
      "loud.hook.mjs",
      `process.stderr.write("a note");\nexport default () => ({});`,
    );
    const result = await runEnvelope(file);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.stderr).toContain("a note");
  });

  it("handles paths with spaces, unicode, #, ?, and %", async () => {
    const weird = join(dir, "dir with spaces hombre #1?%");
    mkdirSync(weird, { recursive: true });
    const file = writeHook(
      "after-task.update.hook.mjs",
      `export default (envelope) => ({ instructions: "weird:" + envelope.event });`,
      weird,
    );
    const result = await runEnvelope(file);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ instructions: "weird:task.update" });
  });

  it("hook input comes ONLY via the argument — stdin is already consumed", async () => {
    // Hook and loader share one process: `readableEnded` proves the loader
    // drained stdin before the import ran. The hook never sees the bytes.
    const file = writeHook(
      "stdin.hook.mjs",
      `export default (envelope) => ({ instructions: "ended=" + process.stdin.readableEnded + " event=" + envelope.event });`,
    );
    const result = await runEnvelope(file);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ instructions: "ended=true event=task.update" });
  });

  it("rejects a non-object envelope on stdin", async () => {
    const file = writeHook("ok.hook.mjs", `export default () => ({});`);
    const result = await runLoader(file, "[1,2,3]");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HOOK_BAD_ENVELOPE");
  });

  it("rejects trailing garbage after the envelope document", async () => {
    const file = writeHook("ok2.hook.mjs", `export default () => ({});`);
    const result = await runLoader(file, `${JSON.stringify(ENVELOPE)}\n{"injected":true}`);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("HOOK_BAD_ENVELOPE");
  });

  it("requires an absolute hook path", async () => {
    const child = spawn(process.execPath, [LOADER, "relative.hook.mjs"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (stderr += d));
    const code: number | null = await new Promise((resolvePromise) => {
      child.stdin.end(JSON.stringify(ENVELOPE));
      child.on("close", resolvePromise);
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("HOOK_LOADER_USAGE");
  });

  it("documents non-isolation: the module reads the user's HOME (no sandbox)", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "hook-loader-fakehome-"));
    writeFileSync(join(fakeHome, "token"), "sekret-token");
    const file = writeHook(
      "reader.hook.mjs",
      `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\nexport default () => ({ instructions: readFileSync(join(process.env.HOME, "token"), "utf8") });`,
    );
    const child = spawn(process.execPath, [LOADER, file], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: fakeHome },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    const code: number | null = await new Promise((resolvePromise) => {
      child.stdin.end(JSON.stringify(ENVELOPE));
      child.on("close", resolvePromise);
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ instructions: "sekret-token" });
  });
});
