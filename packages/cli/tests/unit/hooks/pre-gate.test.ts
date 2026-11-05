/**
 * Pre-gate unit tests (Stage 2, ADR-0006, ticket wla7ci2wzbgaj5dqsrvh1j4o):
 * parsePreHookOutput (explicit allow / deny / malformed), emitPreHook
 * (allow, deny, bypass-notice+audit, conflict, untrusted, kill-switch),
 * preGateRefusal mapping, and the bypass audit helpers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createHookScope,
  emitAfterHook,
  emitPreHook,
  preGateRefusal,
} from "../../../src/core/hooks/emit.js";
import { parsePreHookOutput } from "../../../src/core/hooks/runner.js";
import { buildHookEnvelope } from "../../../src/core/hooks/envelope.js";
import {
  bypassAuditPath,
  formatBypassNotice,
  writeBypassAudit,
} from "../../../src/core/hooks/bypass.js";

let projectDir: string;
let home: string;

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: "",
  VIBEFLOW_HOOKS: "1",
  VIBEFLOW_TRUST_HOOKS: "1",
};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "hook-pre-proj-"));
  home = mkdtempSync(join(tmpdir(), "hook-pre-home-"));
  BASE_ENV.HOME = home;
});

function writePreHook(
  event = "task.update",
  body = `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({allow:true}))});`,
): string {
  const dir = join(projectDir, ".vibeflow-hooks", "pre");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pre-${event}.mjs`);
  writeFileSync(file, body);
  return file;
}

describe("parsePreHookOutput", () => {
  it("accepts an explicit {allow:true}", () => {
    expect(parsePreHookOutput(`{"allow":true}`)).toEqual({
      ok: true,
      decision: { allow: true },
    });
  });

  it("accepts {allow:true} with string instructions", () => {
    expect(
      parsePreHookOutput(`{"allow":true,"instructions":"do x"}`),
    ).toEqual({ ok: true, decision: { allow: true, instructions: "do x" } });
  });

  it("accepts {allow:false,reason} with a non-empty reason", () => {
    expect(parsePreHookOutput(`{"allow":false,"reason":"no"}`)).toEqual({
      ok: true,
      decision: { allow: false, reason: "no" },
    });
  });

  it("rejects empty stdout, non-JSON, and missing allow as HOOK_PRE_MALFORMED", () => {
    for (const bad of ["", "   ", "not json", `{}`, `{"instructions":"x"}`]) {
      expect(parsePreHookOutput(bad)).toEqual({
        ok: false,
        reason: "HOOK_PRE_MALFORMED",
      });
    }
  });

  it("rejects deny without a non-empty reason and any extra keys", () => {
    for (const bad of [
      `{"allow":false}`,
      `{"allow":false,"reason":""}`,
      `{"allow":true,"extra":1}`,
      `{"allow":false,"reason":"x","extra":1}`,
      `{"allow":true,"instructions":42}`,
    ]) {
      expect(parsePreHookOutput(bad)).toEqual({
        ok: false,
        reason: "HOOK_PRE_MALFORMED",
      });
    }
  });

  it("rejects non-boolean allow", () => {
    expect(parsePreHookOutput(`{"allow":"yes"}`)).toEqual({
      ok: false,
      reason: "HOOK_PRE_MALFORMED",
    });
  });
});

describe("emitPreHook", () => {
  it("allows when no hook file exists anywhere (nothing to enforce)", async () => {
    const out = await emitPreHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { home, env: { ...BASE_ENV } },
    );
    expect(out).toEqual({ allowed: true, instructions: [], bypassed: false });
  });

  it("allows on {allow:true} and carries replacement instructions", async () => {
    writePreHook(
      "task.update",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:true,instructions:"updated draft"}))});`,
    );
    const out = await emitPreHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { home, env: { ...BASE_ENV } },
    );
    expect(out.allowed).toBe(true);
    expect(out.instructions).toEqual(["updated draft"]);
    expect(out.bypassed).toBe(false);
  });

  it("denies on {allow:false,reason} with the hook's own reason", async () => {
    writePreHook(
      "task.update",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:false,reason:"frozen board"}))});`,
    );
    const out = await emitPreHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { home, env: { ...BASE_ENV } },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_PRE_DENIED");
    expect(out.reason).toBe("frozen board");
  });

  it("blocks on garbage stdout (fail-closed, never a silent pass)", async () => {
    writePreHook(
      "task.update",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("garbage")});`,
    );
    const out = await emitPreHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { home, env: { ...BASE_ENV } },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_PRE_MALFORMED");
  });

  it("blocks on non-zero exit (fail-closed)", async () => {
    writePreHook(
      "task.update",
      `process.stdin.resume();process.stdin.on("end",()=>{process.exit(3)});`,
    );
    const out = await emitPreHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { home, env: { ...BASE_ENV } },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_PRE_NONZERO_EXIT");
  });

  it("blocks on timeout (fail-closed)", async () => {
    writePreHook(
      "task.update",
      `process.stdin.resume();setTimeout(()=>{process.stdout.write(JSON.stringify({allow:true}))},5000);`,
    );
    const out = await emitPreHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { home, env: { ...BASE_ENV }, timeoutMs: 100 },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_PRE_TIMEOUT");
  });

  it("bypasses LOUDLY on --no-verify: allowed + bypassed, notice + audit record", async () => {
    writePreHook(
      "task.update",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:false,reason:"must not run"}))});`,
    );
    const out = await emitPreHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      {
        payload: { taskId: "abc", changed: ["status"] },
        bypass: true,
        command: "tasks --edit",
      },
      { home, env: { ...BASE_ENV } },
    );
    // The denying hook never ran: bypass wins, but it is recorded.
    expect(out).toEqual({ allowed: true, instructions: [], bypassed: true });
    const auditLine = readFileSync(bypassAuditPath(home), "utf8").trim();
    const record = JSON.parse(auditLine) as Record<string, unknown>;
    expect(record["event"]).toBe("task.update");
    expect(record["phase"]).toBe("pre");
    expect(record["command"]).toBe("tasks --edit");
    expect(record["reason"]).toBe("--no-verify");
    expect(typeof record["ts"]).toBe("string");
  });

  it("refuses on same-level stdio+module conflict (fail-closed, not open)", async () => {
    const dir = join(projectDir, ".vibeflow-hooks", "pre");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pre-task.update.mjs"), "process.exit(0);");
    writeFileSync(
      join(dir, "pre-task.update.hook.mjs"),
      "export default async () => ({allow:true});",
    );
    const out = await emitPreHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { home, env: { ...BASE_ENV } },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_CONFIG_CONFLICT");
  });

  it("blocks an untrusted project hook (never an open gate)", async () => {
    writePreHook();
    const out = await emitPreHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      // No VIBEFLOW_TRUST_HOOKS: non-TTY cannot prompt, so trust refuses.
      { home, env: { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: undefined } },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_PRE_UNTRUSTED");
  });

  it("returns allowed when the kill-switch is set (explicit, never silent)", async () => {
    writePreHook(
      "task.update",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:false,reason:"must not run"}))});`,
    );
    const out = await emitPreHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { home, env: { ...BASE_ENV, VIBEFLOW_HOOKS: "0" } },
    );
    expect(out).toEqual({ allowed: true, instructions: [], bypassed: false });
  });
});

describe("pre refusedSibling wrong-dir gate (ticket 746155ce)", () => {
  async function captureStderr(fn: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const orig = process.stderr.write;
    (process.stderr.write as unknown as (...args: unknown[]) => boolean) =
      ((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
    try {
      await fn();
    } finally {
      process.stderr.write = orig;
    }
    return lines.join("");
  }

  // The pre lookup lives in `.vibeflow-hooks/pre/` (same dir the gate
  // must check — the bug checked the bare hooks root, so this stayed
  // silent). Fails on the old code (no warning), passes on the fix.
  it("warns HOOK_BAD_EXTENSION for a pre .js beside a valid pre .mjs (project level, right dir)", async () => {
    writePreHook();
    const bad = join(projectDir, ".vibeflow-hooks", "pre", "pre-task.update.js");
    writeFileSync(bad, `// wrong extension\n`);
    let out!: Awaited<ReturnType<typeof emitPreHook>>;
    const stderr = await captureStderr(async () => {
      out = await emitPreHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { payload: { taskId: "abc", changed: ["status"] } },
        { home, env: { ...BASE_ENV } },
      );
    });
    expect(stderr).toContain("HOOK_BAD_EXTENSION");
    expect(stderr).toContain(bad);
    // The gate itself still runs: the valid .mjs allows the write.
    expect(out.allowed).toBe(true);
  });

  it("refuses .cjs for pre at the project level", async () => {
    writePreHook();
    const bad = join(projectDir, ".vibeflow-hooks", "pre", "pre-task.update.cjs");
    writeFileSync(bad, `// wrong extension\n`);
    const stderr = await captureStderr(async () => {
      await emitPreHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { payload: { taskId: "abc", changed: ["status"] } },
        { home, env: { ...BASE_ENV } },
      );
    });
    expect(stderr).toContain("HOOK_BAD_EXTENSION");
    expect(stderr).toContain(bad);
  });

  it("warns for a pre .js at the global level", async () => {
    const dir = join(home, ".vibeflow", "hooks", "pre");
    mkdirSync(dir, { recursive: true });
    const bad = join(dir, "pre-task.update.js");
    writeFileSync(bad, `// wrong extension\n`);
    const stderr = await captureStderr(async () => {
      await emitPreHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { payload: { taskId: "abc", changed: ["status"] } },
        { home, env: { ...BASE_ENV } },
      );
    });
    expect(stderr).toContain("HOOK_BAD_EXTENSION");
    expect(stderr).toContain(bad);
  });

  it("stays silent when the .js is NOT a sibling of the pre lookup dir (after/ only)", async () => {
    writePreHook();
    const afterDir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(afterDir, { recursive: true });
    writeFileSync(join(afterDir, "pre-task.update.js"), `// wrong dir\n`);
    const stderr = await captureStderr(async () => {
      await emitPreHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { payload: { taskId: "abc", changed: ["status"] } },
        { home, env: { ...BASE_ENV } },
      );
    });
    expect(stderr).not.toContain("HOOK_BAD_EXTENSION");
  });

  it("after behaviour unchanged: an after .js beside a valid after .mjs still warns", async () => {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "after-task.update.mjs"),
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:"ok"}))});`,
    );
    const bad = join(dir, "after-task.update.js");
    writeFileSync(bad, `// wrong extension\n`);
    let out!: string[];
    const stderr = await captureStderr(async () => {
      out = await emitAfterHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { taskId: "abc", changed: ["status"] },
        { home, env: { ...BASE_ENV } },
      );
    });
    expect(stderr).toContain("HOOK_BAD_EXTENSION");
    expect(stderr).toContain(bad);
    expect(out).toEqual(["ok"]);
  });
});

describe("preGateRefusal", () => {
  it("keeps the gate code and human reason verbatim (never renamed)", () => {
    expect(
      preGateRefusal({
        allowed: false,
        code: "HOOK_PRE_DENIED",
        reason: "frozen board",
        instructions: [],
        bypassed: false,
      }),
    ).toEqual({ code: "HOOK_PRE_DENIED", message: "frozen board" });
  });
});

describe("bypass audit", () => {
  it("formats the HOOK_BYPASSED notice with event + command", () => {
    expect(formatBypassNotice("push", "push")).toContain("HOOK_BYPASSED push");
    expect(formatBypassNotice("push", "push")).toContain("--no-verify");
  });

  it("appends one JSONL record per bypass (append-only, never throws)", () => {
    writeBypassAudit(
      { event: "push", phase: "pre", command: "push", reason: "--no-verify" },
      home,
    );
    writeBypassAudit(
      { event: "pull", phase: "pre", command: "pull", reason: "--no-verify" },
      home,
    );
    const lines = readFileSync(bypassAuditPath(home), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as { event: string }).event).toBe("push");
    expect((JSON.parse(lines[1]) as { event: string }).event).toBe("pull");
  });

  it("an unwritable audit path warns but never throws", () => {
    // A regular FILE as the home root: mkdirSync beneath it cannot
    // succeed, so the write fails closed into a stderr warning only.
    const blocker = join(home, "blocker");
    writeFileSync(blocker, "x");
    expect(() =>
      writeBypassAudit(
        { event: "push", phase: "pre", command: "push", reason: "--no-verify" },
        join(blocker, "sub"),
      ),
    ).not.toThrow();
    // Sanity: the helper really resolves under the given home.
    expect(bypassAuditPath(home)).toContain(".vibeflow");
  });
});

describe("pre-phase envelope", () => {
  it("builds a pre envelope with INTENT payload and replaceable instructions", () => {
    const envelope = buildHookEnvelope({
      event: "task.create",
      phase: "pre",
      boardId: null,
      actor: "agent",
      payload: { title: "t" },
      task: { title: "t" },
      instructions: "",
    });
    expect(envelope.phase).toBe("pre");
    expect(envelope.payload).toEqual({ title: "t" });
    expect(envelope.activity).toBe("task.create");
    expect(envelope.instructions).toBe("");
    // No generated id on a create intent.
    expect(envelope.payload).not.toHaveProperty("id");
  });
});
