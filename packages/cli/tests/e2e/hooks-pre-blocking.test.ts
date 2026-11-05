/**
 * Pre-hook blocking e2e (Stage 2, ADR-0006, ticket wla7ci2wzbgaj5dqsrvh1j4o):
 * real CLI spawns against a temp project with trusted project pre-hooks.
 * - allow: edit lands, exactly ONE JSON doc;
 * - deny: non-zero exit, hook reason surfaced, store UNCHANGED;
 * - modify: {allow:true,instructions} replaces the draft (rides success);
 * - timeout / garbage: fail-CLOSED, store unchanged;
 * - --no-verify: bypass notice on stderr + local audit record, write lands;
 * - trust-deny: untrusted project pre blocks, never silently passes;
 * - module mode (.hook.mjs) gates like stdio;
 * - create + delete + claim gates block too (store unchanged on block).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCliIsolated } from "./spawn-isolated.js";
import { ensureTaskDirs } from "../../src/core/tasks.js";

let cliHome!: string;
let projectDir!: string;

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "hookpre-e2e-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "hookpre-e2e-proj-"));
  ensureTaskDirs(projectDir);
});

afterEach(() => {
  rmSync(cliHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const HOOK_ENV = { VIBEFLOW_HOOKS: "1", VIBEFLOW_TRUST_HOOKS: "1" };

/**
 * Refusal convention (tasks-json-refusals): non-zero exit, EMPTY stdout,
 * exactly ONE JSON envelope on stderr carrying the assigned code.
 */
function expectGateRefusal(
  r: { stdout: string; stderr: string; code: number | null },
  code: string,
  reasonFragment: string,
): void {
  expect(r.code).not.toBe(0);
  expect(r.stdout.trim()).toBe("");
  // stderr carries hook chatter (trust/deny lines) plus the ONE refusal
  // envelope as its last JSON line — never prose on stdout.
  const lastJson = r.stderr
    .trim()
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .pop();
  const envelope = JSON.parse(lastJson ?? "") as {
    ok: boolean;
    error: { code: string; message: string };
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.error.code).toBe(code);
  expect(envelope.error.message).toContain(reasonFragment);
}

function writePreHook(event: string, body: string, module = false): void {
  const dir = join(projectDir, ".vibeflow-hooks", "pre");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, module ? `pre-${event}.hook.mjs` : `pre-${event}.mjs`),
    body,
  );
}

const ALLOW = `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({allow:true}))});`;
const DENY = (reason: string) =>
  `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:false,reason:${JSON.stringify(reason)}}))});`;

async function addTask(title = "hook pre e2e task"): Promise<string> {
  const added = await spawnCliIsolated(
    ["tasks", "--add", "--title", title, "--json"],
    { cwd: projectDir, home: cliHome, env: HOOK_ENV },
  );
  expect(added.code).toBe(0);
  return (JSON.parse(added.stdout) as { task: { id: string } }).task.id;
}

async function taskStatus(id: string): Promise<string> {
  const got = await spawnCliIsolated(["tasks", "--get", id, "--json"], {
    cwd: projectDir,
    home: cliHome,
    env: HOOK_ENV,
  });
  expect(got.code).toBe(0);
  return (JSON.parse(got.stdout) as { task: { status: string } }).task.status;
}

describe("hooks-pre-blocking e2e", () => {
  it("allow: edit lands with exactly ONE JSON doc", async () => {
    const id = await addTask();
    writePreHook("task.update", ALLOW);
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).toBe(0);
    const doc = JSON.parse(edited.stdout) as { ok: boolean };
    expect(doc.ok).toBe(true);
    expect(await taskStatus(id)).toBe("in-progress");
  });

  it("deny: non-zero exit, reason surfaced, store UNCHANGED, one envelope on stderr", async () => {
    const id = await addTask();
    writePreHook("task.update", DENY("frozen board"));
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expectGateRefusal(edited, "HOOK_PRE_DENIED", "frozen board");
    expect(await taskStatus(id)).toBe("todo");
  });

  it("modify: {allow:true,instructions} rides the success document", async () => {
    const id = await addTask();
    writePreHook(
      "task.update",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:true,instructions:"pre draft"}))});`,
    );
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
    expect(doc.instructions).toContain("pre draft");
    expect(await taskStatus(id)).toBe("in-progress");
  });

  it("timeout: fail-CLOSED, store unchanged", async () => {
    const id = await addTask();
    writePreHook(
      "task.update",
      `process.stdin.resume();setTimeout(()=>{process.stdout.write(JSON.stringify({allow:true}))},15000);`,
    );
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).not.toBe(0);
    expect(await taskStatus(id)).toBe("todo");
  });

  it("garbage stdout: fail-CLOSED, store unchanged", async () => {
    const id = await addTask();
    writePreHook(
      "task.update",
      `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("not json at all")});`,
    );
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).not.toBe(0);
    expect(await taskStatus(id)).toBe("todo");
  });

  it("--no-verify: bypass notice + audit record, write lands", async () => {
    const id = await addTask();
    writePreHook("task.update", DENY("must not run"));
    const edited = await spawnCliIsolated(
      [
        "tasks",
        "--edit",
        id,
        "--set-status",
        "in-progress",
        "--json",
        "--no-verify",
      ],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).toBe(0);
    const doc = JSON.parse(edited.stdout) as { ok: boolean };
    expect(doc.ok).toBe(true);
    expect(edited.stderr).toContain("HOOK_BYPASSED");
    expect(await taskStatus(id)).toBe("in-progress");
    const audit = join(cliHome, ".vibeflow", "hooks", "bypass-audit.log");
    expect(existsSync(audit)).toBe(true);
    const lines = readFileSync(audit, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]) as {
      event: string;
      phase: string;
    };
    expect(last.event).toBe("task.update");
    expect(last.phase).toBe("pre");
  });

  it("trust-deny: untrusted project pre BLOCKS (never silently passes)", async () => {
    const id = await addTask();
    writePreHook("task.update", ALLOW);
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      // No VIBEFLOW_TRUST_HOOKS: non-TTY cannot prompt, so the gate refuses.
      { cwd: projectDir, home: cliHome, env: { VIBEFLOW_HOOKS: "1" } },
    );
    expect(edited.code).not.toBe(0);
    expect(await taskStatus(id)).toBe("todo");
  });

  it("module mode (.hook.mjs) denies like stdio", async () => {
    const id = await addTask();
    writePreHook(
      "task.update",
      `export default async () => ({ allow: false, reason: "module says no" });`,
      true,
    );
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expectGateRefusal(edited, "HOOK_PRE_DENIED", "module says no");
    expect(await taskStatus(id)).toBe("todo");
  });

  it("create gate: deny blocks the add, store unchanged", async () => {
    writePreHook("task.create", DENY("no new tasks"));
    const added = await spawnCliIsolated(
      ["tasks", "--add", "--title", "blocked create", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expectGateRefusal(added, "HOOK_PRE_DENIED", "no new tasks");
    const listed = await spawnCliIsolated(["tasks", "--json"], {
      cwd: projectDir,
      home: cliHome,
      env: HOOK_ENV,
    });
    expect(listed.stdout).not.toContain("blocked create");
  });

  it("delete gate: deny blocks the delete", async () => {
    const id = await addTask();
    writePreHook("task.delete", DENY("no deletes"));
    const deleted = await spawnCliIsolated(
      ["tasks", "--delete", id, "--yes", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(deleted.code).not.toBe(0);
    expect(await taskStatus(id)).toBe("todo");
  });

  it("claim gate: deny blocks --next, store unchanged", async () => {
    await addTask();
    writePreHook("task.claim", DENY("no claims today"));
    const claimed = await spawnCliIsolated(["tasks", "--next", "--json"], {
      cwd: projectDir,
      home: cliHome,
      env: HOOK_ENV,
    });
    expectGateRefusal(claimed, "HOOK_PRE_DENIED", "no claims today");
  });
});
