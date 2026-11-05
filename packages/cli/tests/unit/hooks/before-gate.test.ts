/**
 * Before-gate unit tests (ADR-0007): parseBeforeHookOutput (explicit
 * allow / deny / malformed), emitBeforeHook (allow, deny,
 * bypass-notice+audit, conflict, untrusted, kill-switch),
 * beforeGateRefusal mapping, and the bypass audit helpers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createHookScope,
  emitAfterHook,
  emitBeforeHook,
  beforeGateRefusal,
  resetShippedMissingWarning,
} from "../../../src/core/hooks/emit.js";
import { parseBeforeHookOutput } from "../../../src/core/hooks/runner.js";
import { buildHookEnvelope } from "../../../src/core/hooks/envelope.js";
import {
  bypassAuditPath,
  formatBypassNotice,
  writeBypassAudit,
} from "../../../src/core/hooks/bypass.js";
import { resetUnrunnableHookWarnings } from "../../../src/core/hooks/discover.js";

let projectDir: string;
let home: string;
/** Isolated shipped root (empty) — gates never see the real bundle tree. */
let shippedDir: string;

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: "",
  VIBEFLOW_HOOKS: "1",
  VIBEFLOW_TRUST_HOOKS: "1",
};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "hook-before-proj-"));
  home = mkdtempSync(join(tmpdir(), "hook-before-home-"));
  shippedDir = mkdtempSync(join(tmpdir(), "hook-before-shipped-"));
  BASE_ENV.HOME = home;
  resetUnrunnableHookWarnings();
  resetShippedMissingWarning();
});

const gateOpts = (): { home: string; shippedDir: string } => ({ home, shippedDir });

function writeBeforeHook(
  tool = "tasks",
  body = `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({allow:true}))});`,
): string {
  const dir = join(projectDir, ".vibeflow-hooks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tool}.before.mjs`);
  writeFileSync(file, body);
  return file;
}

describe("parseBeforeHookOutput", () => {
  it("accepts an explicit {allow:true}", () => {
    expect(parseBeforeHookOutput(`{"allow":true}`)).toEqual({
      ok: true,
      decision: { allow: true },
    });
  });

  it("accepts {allow:true} with string instructions", () => {
    expect(
      parseBeforeHookOutput(`{"allow":true,"instructions":"do x"}`),
    ).toEqual({ ok: true, decision: { allow: true, instructions: "do x" } });
  });

  it("accepts {allow:false,reason} with a non-empty reason", () => {
    expect(parseBeforeHookOutput('{"allow":false,"reason":"no"}')).toEqual({
      ok: true,
      decision: { allow: false, reason: "no" },
    });
  });

  it("rejects empty stdout, non-JSON, and missing allow as HOOK_BEFORE_MALFORMED", () => {
    for (const bad of ["", "   ", "not json", `{}`, `{"instructions":"x"}`]) {
      expect(parseBeforeHookOutput(bad)).toEqual({
        ok: false,
        reason: "HOOK_BEFORE_MALFORMED",
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
      expect(parseBeforeHookOutput(bad)).toEqual({
        ok: false,
        reason: "HOOK_BEFORE_MALFORMED",
      });
    }
  });

  it("rejects non-boolean allow", () => {
    expect(parseBeforeHookOutput(`{"allow":"yes"}`)).toEqual({
      ok: false,
      reason: "HOOK_BEFORE_MALFORMED",
    });
  });
});

describe("emitBeforeHook", () => {
  it("allows when no hook file exists anywhere (nothing to enforce)", async () => {
    const out = await emitBeforeHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { ...gateOpts(), env: { ...BASE_ENV } },
    );
    expect(out).toEqual({ allowed: true, instructions: [], bypassed: false });
  });

  it("allows on {allow:true} and carries replacement instructions", async () => {
    writeBeforeHook(
      "tasks",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:true,instructions:"updated draft"}))});`,
    );
    const out = await emitBeforeHook(
      { projectDir, mode: "local" },
      createHookScope({ tool: "tasks", surface: "cli" }),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { ...gateOpts(), env: { ...BASE_ENV } },
    );
    expect(out.allowed).toBe(true);
    expect(out.instructions).toEqual(["updated draft"]);
    expect(out.bypassed).toBe(false);
  });

  it("denies on {allow:false,reason} with the hook's own reason", async () => {
    writeBeforeHook(
      "tasks",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:false,reason:"frozen board"}))});`,
    );
    const out = await emitBeforeHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { ...gateOpts(), env: { ...BASE_ENV } },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_BEFORE_DENIED");
    expect(out.reason).toBe("frozen board");
  });

  it("blocks on garbage stdout (fail-closed, never a silent pass)", async () => {
    writeBeforeHook(
      "tasks",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("garbage")});`,
    );
    const out = await emitBeforeHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { ...gateOpts(), env: { ...BASE_ENV } },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_BEFORE_MALFORMED");
  });

  it("blocks on non-zero exit (fail-closed)", async () => {
    writeBeforeHook(
      "tasks",
      `process.stdin.resume();process.stdin.on("end",()=>{process.exit(3)});`,
    );
    const out = await emitBeforeHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { ...gateOpts(), env: { ...BASE_ENV } },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_BEFORE_NONZERO_EXIT");
  });

  it("blocks on timeout (fail-closed)", async () => {
    writeBeforeHook(
      "tasks",
      `process.stdin.resume();setTimeout(()=>{process.stdout.write(JSON.stringify({allow:true}))},5000);`,
    );
    const out = await emitBeforeHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { ...gateOpts(), env: { ...BASE_ENV }, timeoutMs: 100 },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_BEFORE_TIMEOUT");
  });

  it("bypasses LOUDLY on --no-verify: allowed + bypassed, notice + audit record", async () => {
    writeBeforeHook(
      "tasks",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:false,reason:"must not run"}))});`,
    );
    const out = await emitBeforeHook(
      { projectDir, mode: "local" },
      createHookScope({ tool: "tasks", surface: "cli" }),
      "task.update",
      {
        payload: { taskId: "abc", changed: ["status"] },
        bypass: true,
        command: "tasks --edit",
      },
      { ...gateOpts(), env: { ...BASE_ENV } },
    );
    // The denying hook never ran: bypass wins, but it is recorded.
    expect(out).toEqual({ allowed: true, instructions: [], bypassed: true });
    const auditLine = readFileSync(bypassAuditPath(home), "utf8").trim();
    const record = JSON.parse(auditLine) as Record<string, unknown>;
    expect(record["tool"]).toBe("tasks");
    expect(record["activity"]).toBe("task.update");
    expect(record["phase"]).toBe("before");
    expect(record["command"]).toBe("tasks --edit");
    expect(record["reason"]).toBe("--no-verify");
    expect(typeof record["ts"]).toBe("string");
  });

  it("refuses on same-level stdio+module conflict (fail-closed, not open)", async () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.before.mjs"), "process.exit(0);");
    writeFileSync(
      join(dir, "tasks.before.hook.mjs"),
      "export default async () => ({allow:true});",
    );
    const out = await emitBeforeHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { ...gateOpts(), env: { ...BASE_ENV } },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_CONFIG_CONFLICT");
  });

  it("blocks an untrusted project hook (never an open gate)", async () => {
    writeBeforeHook();
    const out = await emitBeforeHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      // No VIBEFLOW_TRUST_HOOKS: non-TTY cannot prompt, so trust refuses.
      { ...gateOpts(), env: { ...BASE_ENV, VIBEFLOW_TRUST_HOOKS: undefined } },
    );
    expect(out.allowed).toBe(false);
    expect(out.code).toBe("HOOK_BEFORE_UNTRUSTED");
  });

  it("returns allowed when the kill-switch is set (explicit, never silent)", async () => {
    writeBeforeHook(
      "tasks",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:false,reason:"must not run"}))});`,
    );
    const out = await emitBeforeHook(
      { projectDir, mode: "local" },
      createHookScope(),
      "task.update",
      { payload: { taskId: "abc", changed: ["status"] } },
      { ...gateOpts(), env: { ...BASE_ENV, VIBEFLOW_HOOKS: "0" } },
    );
    expect(out).toEqual({ allowed: true, instructions: [], bypassed: false });
  });
});

describe("flat refusedSibling gate (ticket 746155ce, flat-dir equivalent)", () => {
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

  // The flat lookup lives in `.vibeflow-hooks/` (the same dir the gate
  // must check — 623b164 moved the check from the bare hooks root into
  // the `pre/` dir; the flat layout subsumes that special case). Fails on
  // the old code (no warning), passes on the fix.
  it("warns HOOK_BAD_EXTENSION for a before .js beside a valid before .mjs (flat, project level)", async () => {
    writeBeforeHook();
    const bad = join(projectDir, ".vibeflow-hooks", "tasks.before.js");
    writeFileSync(bad, `// wrong extension\n`);
    let out!: Awaited<ReturnType<typeof emitBeforeHook>>;
    const stderr = await captureStderr(async () => {
      out = await emitBeforeHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { payload: { taskId: "abc", changed: ["status"] } },
        { ...gateOpts(), env: { ...BASE_ENV } },
      );
    });
    expect(stderr).toContain("HOOK_BAD_EXTENSION");
    expect(stderr).toContain(bad);
    // The gate itself still runs: the valid .mjs allows the write.
    expect(out.allowed).toBe(true);
  });

  it("refuses .cjs for before at the project level", async () => {
    writeBeforeHook();
    const bad = join(projectDir, ".vibeflow-hooks", "tasks.before.cjs");
    writeFileSync(bad, `// wrong extension\n`);
    const stderr = await captureStderr(async () => {
      await emitBeforeHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { payload: { taskId: "abc", changed: ["status"] } },
        { ...gateOpts(), env: { ...BASE_ENV } },
      );
    });
    expect(stderr).toContain("HOOK_BAD_EXTENSION");
    expect(stderr).toContain(bad);
  });

  it("warns for a before .js at the global level", async () => {
    const dir = join(home, ".vibeflow", "hooks");
    mkdirSync(dir, { recursive: true });
    const bad = join(dir, "tasks.before.js");
    writeFileSync(bad, `// wrong extension\n`);
    const stderr = await captureStderr(async () => {
      await emitBeforeHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { payload: { taskId: "abc", changed: ["status"] } },
        { ...gateOpts(), env: { ...BASE_ENV } },
      );
    });
    expect(stderr).toContain("HOOK_BAD_EXTENSION");
    expect(stderr).toContain(bad);
  });

  it("stays silent when the .js is NOT in a lookup dir (stale pre/ subdir)", async () => {
    writeBeforeHook();
    const staleDir = join(projectDir, ".vibeflow-hooks", "before");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "tasks.before.js"), `// wrong dir\n`);
    const stderr = await captureStderr(async () => {
      await emitBeforeHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { payload: { taskId: "abc", changed: ["status"] } },
        { ...gateOpts(), env: { ...BASE_ENV } },
      );
    });
    expect(stderr).not.toContain("HOOK_BAD_EXTENSION");
  });

  it("after behaviour unchanged: an after .js beside a valid after .mjs still warns", async () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tasks.after.mjs"),
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:"ok"}))});`,
    );
    const bad = join(dir, "tasks.after.js");
    writeFileSync(bad, `// wrong extension\n`);
    let out!: string[];
    const stderr = await captureStderr(async () => {
      out = await emitAfterHook(
        { projectDir, mode: "local" },
        createHookScope(),
        "task.update",
        { taskId: "abc", changed: ["status"] },
        { ...gateOpts(), env: { ...BASE_ENV } },
      );
    });
    expect(stderr).toContain("HOOK_BAD_EXTENSION");
    expect(stderr).toContain(bad);
    expect(out).toEqual(["ok"]);
  });
});

describe("beforeGateRefusal", () => {
  it("keeps the gate code and human reason verbatim (never renamed)", () => {
    expect(
      beforeGateRefusal({
        allowed: false,
        code: "HOOK_BEFORE_DENIED",
        reason: "frozen board",
        instructions: [],
        bypassed: false,
      }),
    ).toEqual({ code: "HOOK_BEFORE_DENIED", message: "frozen board" });
  });
});

describe("bypass audit", () => {
  it("formats the HOOK_BYPASSED notice with tool + command", () => {
    expect(formatBypassNotice("push", "push")).toContain("HOOK_BYPASSED push");
    expect(formatBypassNotice("push", "push")).toContain("--no-verify");
  });

  it("appends one JSONL record per bypass (append-only, never throws)", () => {
    writeBypassAudit(
      { tool: "push", activity: "push", phase: "before", command: "push", reason: "--no-verify" },
      home,
    );
    writeBypassAudit(
      { tool: "pull", activity: "pull", phase: "before", command: "pull", reason: "--no-verify" },
      home,
    );
    const lines = readFileSync(bypassAuditPath(home), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as { activity: string }).activity).toBe("push");
    expect((JSON.parse(lines[1]) as { activity: string }).activity).toBe("pull");
  });

  it("an unwritable audit path warns but never throws", () => {
    // A regular FILE as the home root: mkdirSync beneath it cannot
    // succeed, so the write fails closed into a stderr warning only.
    const blocker = join(home, "blocker");
    writeFileSync(blocker, "x");
    expect(() =>
      writeBypassAudit(
        { tool: "push", activity: "push", phase: "before", command: "push", reason: "--no-verify" },
        join(blocker, "sub"),
      ),
    ).not.toThrow();
    // Sanity: the helper really resolves under the given home.
    expect(bypassAuditPath(home)).toContain(".vibeflow");
  });
});

describe("before-phase envelope", () => {
  it("builds a before envelope with INTENT payload and replaceable instructions", () => {
    const envelope = buildHookEnvelope({
      tool: "tasks",
      surface: "cli",
      activity: "task.create",
      phase: "before",
      boardId: null,
      actor: "agent",
      payload: { title: "t" },
      task: { title: "t" },
      instructions: "",
    });
    expect(envelope.phase).toBe("before");
    expect(envelope.payload).toEqual({ title: "t" });
    expect(envelope.activity).toBe("task.create");
    expect(envelope.tool).toBe("tasks");
    expect(envelope.instructions).toBe("");
    // No generated id on a create intent.
    expect(envelope.payload).not.toHaveProperty("id");
  });
});
