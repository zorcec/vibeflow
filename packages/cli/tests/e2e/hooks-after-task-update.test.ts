/**
 * After-hook e2e (Stage 1, ADR-0006): a real CLI spawn with a trusted
 * project after-hook.
 * - `tasks --edit --json` success path = exactly ONE JSON doc on stdout,
 *   carrying `instructions` from the hook;
 * - stdout stays byte-clean (`JSON.parse` of the whole stream);
 * - an untrusted project hook does not run and says why on stderr.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
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
  const dir = join(projectDir, ".vibeflow-hooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tasks.after.mjs"), body);
}

describe("hooks-after-task-update e2e", () => {
  it("tasks --edit --json success = exactly ONE JSON doc carrying hook instructions", async () => {
    const id = await addTask();
    writeProjectHook(
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify({instructions:"hook saw "+e.activity}));});`,
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

describe("hooks-after-task-update module mode e2e (Stage 1.5, ADR-0006)", () => {
  function writeModuleHook(body: string): void {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.after.hook.mjs"), body);
  }

  it("module hook success = exactly ONE JSON doc carrying the instruction", async () => {
    const id = await addTask();
    writeModuleHook(
      `export default async (envelope) => ({ instructions: "module saw " + envelope.activity });`,
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
    expect(doc.instructions).toEqual(["module saw task.update"]);
  });

  it("human renderer displays the module instruction on stderr", async () => {
    const id = await addTask();
    writeModuleHook(
      `export default async () => ({ instructions: "human-visible-module-note" });`,
    );
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).toBe(0);
    expect(edited.stderr).toContain("hook: human-visible-module-note");
  });

  it("conflict refuses with HOOK_CONFIG_CONFLICT and no lower-level default", async () => {
    const id = await addTask();
    writeProjectHook(
      `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:"stdio must not run"}))});`,
    );
    writeModuleHook(`export default async () => ({ instructions: "module must not run" });`);
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
    // Fail-open with NO fallback: neither hook's instruction, neither the
    // shipped default's unconditional text.
    expect(doc.instructions).toBeUndefined();
    expect(edited.stderr).toContain("HOOK_CONFIG_CONFLICT");
    expect(edited.stderr).not.toContain('NEVER set a task status to "done"');
  });

  it("untrusted module hook refuses (non-TTY) with no default fallback", async () => {
    const id = await addTask();
    writeModuleHook(`export default async () => ({ instructions: "must not run" });`);
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
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

  it("module {} no-op succeeds with no instructions (not a fake success)", async () => {
    const id = await addTask();
    writeModuleHook(`export default async () => ({});`);
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
    expect(doc.instructions).toBeUndefined();
    expect(edited.stderr).not.toContain("hook: ");
  });

  it("a failing module hook persists the update and never retries", async () => {
    const id = await addTask();
    writeModuleHook(`process.exit(3);`);
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).toBe(0);
    const doc = JSON.parse(edited.stdout) as {
      ok: boolean;
      task?: { status?: string };
      instructions?: string[];
    };
    expect(doc.ok).toBe(true);
    expect(doc.instructions).toBeUndefined();
    expect(edited.stderr).toContain("HOOK_NONZERO_EXIT");
    // The write persisted despite the hook failure (fail-open, after = open).
    const fetched = await spawnCliIsolated(
      ["tasks", "--get", id, "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(fetched.code).toBe(0);
    const got = JSON.parse(fetched.stdout) as { task?: { status?: string } };
    expect(got.task?.status).toBe("in-progress");
  });
});

describe("after-envelope generic fields live (ticket 431ee1c0)", () => {
  // The hook child env carries PATH+HOME only — the capture path is baked
  // into the hook body, never passed as env.
  function writeCaptureHook(_event: string, capture: string): void {
    // v2: one file per TOOL — a single tasks.after.mjs captures every
    // activity; assertions below filter by e.activity.
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `tasks.after.mjs`),
      `import { appendFileSync } from "node:fs";\n` +
        `let s="";process.stdin.setEncoding("utf8").on("data",c=>s+=c).on("end",()=>{appendFileSync(${JSON.stringify(capture)},s+"\\n");process.stdout.write(JSON.stringify({}));});\n`,
    );
  }

  function readCaptures(capture: string): Array<Record<string, unknown>> {
    return readFileSync(capture, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("task.create after-envelope carries the CONFIRMED record as task", async () => {
    const capture = join(projectDir, "capture-create.jsonl");
    writeCaptureHook("task.create", capture);
    const added = await spawnCliIsolated(
      ["tasks", "--add", "--title", "envelope snapshot task", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(added.code).toBe(0);
    const id = (JSON.parse(added.stdout) as { task: { id: string } }).task.id;
    const envelopes = readCaptures(capture);
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0];
    expect(env.activity).toBe("task.create");
    expect(env.tool).toBe("tasks");
    expect(env.surface).toBe("cli");
    expect(env.phase).toBe("after");
    // Pre-fix this was null with no activityObject — the live proof.
    const task = env.task as Record<string, unknown>;
    expect(task).not.toBeNull();
    expect(task.id).toBe(id);
    expect(task.title).toBe("envelope snapshot task");
    expect(task.status).toBe("todo");
    expect("activityObject" in env).toBe(false);
    expect(env.instructions).toBe("");
    expect(env.activity).toBe("task.create");
    // Legacy payload byte-identical.
    expect(env.payload).toEqual({
      task: { id, title: "envelope snapshot task", status: "todo" },
    });
  });

  it("task.update after-envelope carries the post-write record + changed keys", async () => {
    const id = await addTask();
    const capture = join(projectDir, "capture-update.jsonl");
    writeCaptureHook("task.update", capture);
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).toBe(0);
    const envelopes = readCaptures(capture);
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0];
    const task = env.task as Record<string, unknown>;
    expect(task).not.toBeNull();
    expect(task.id).toBe(id);
    expect(task.status).toBe("in-progress");
    // The CLI's --set-status path folds author/verified bookkeeping into
    // the write: pin containment + payload/activityObject agreement,
    // not the exact key set.
    const changed = (env.activityObject as { changed: string[] }).changed;
    expect(changed).toContain("status");
    expect(env.payload).toEqual({ taskId: id, changed });
  });

  it("task.comment after-envelope carries the task + written comment", async () => {
    const id = await addTask();
    const capture = join(projectDir, "capture-cu.jsonl");
    writeCaptureHook("task.update", capture);
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--title", "renamed", "--comment", "live note", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).toBe(0);
    // One file per tool ⇒ one execution per (tool, activity), in order.
    const updates = readCaptures(capture).filter((e) => e.activity === "task.update");
    expect(updates).toHaveLength(1);
    const updateTask = updates[0].task as Record<string, unknown>;
    expect(updateTask.id).toBe(id);
    expect(updateTask.title).toBe("renamed");
    const comments = readCaptures(capture).filter((e) => e.activity === "task.comment");
    expect(comments).toHaveLength(1);
    const commentEnv = comments[0];
    const commentTask = commentEnv.task as Record<string, unknown>;
    expect(commentTask).not.toBeNull();
    expect(commentTask.id).toBe(id);
    const activityObject = commentEnv.activityObject as Record<string, unknown>;
    expect(activityObject.text).toBe("live note");
    expect(commentEnv.payload).toEqual({
      taskId: id,
      commentId: activityObject.id,
    });
  });
});
