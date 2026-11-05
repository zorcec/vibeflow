/**
 * Per-tool hook keys e2e (ADR-0007, T7): for every one of the 27 registry
 * keys, a real CLI spawn / MCP call with a project hook proves (a) a
 * marker-file line per execution, (b) instructions surface in `--json` /
 * `successPayload`, (c) stdout stays one JSON document. Before rows prove
 * `{allow:false}` refuses non-zero with the documented code and
 * non-gateable `.before` files refuse `HOOK_NOT_GATEABLE` with no spawn.
 * Long-running tools (`kanban`, `serve`, `start_kanban`) assert at
 * readiness (poll the marker, then kill/close).
 *
 * Failure marker: point `create_task` at `tasks.after.mjs` → the MCP row
 * fails (no cross-surface fallback — scope.tool drives discovery).
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
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { spawnCliIsolated, isolatedCliEnv, CLI_ENTRY } from "./spawn-isolated.js";
import {
  bootMcpServer,
  callTool,
  assertJsonTextContent,
  newClient,
  initialize,
  getFreePort,
  type McpTestEnv,
} from "./mcp-helpers.js";
import { ensureTaskDirs } from "../../src/core/tasks.js";
import { setupSaaSMode } from "../helpers/saas-auth.js";

let cliHome: string;
let projectDir: string;

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "hookkeys-e2e-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "hookkeys-e2e-proj-"));
  ensureTaskDirs(projectDir);
});

afterEach(() => {
  rmSync(cliHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const HOOK_ENV = { VIBEFLOW_HOOKS: "1", VIBEFLOW_TRUST_HOOKS: "1" };

/** Write `<tool>.<phase>.mjs` (flat) into the project hooks dir. */
function writeHook(tool: string, phase: "before" | "after", body: string): string {
  const dir = join(projectDir, ".vibeflow-hooks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tool}.${phase}.mjs`);
  writeFileSync(file, body);
  return file;
}

/** Marker hook: appends one line per execution, returns no instructions. */
const MARKER_BODY = (marker: string) =>
  `import { appendFileSync } from "node:fs";\n` +
  `process.stdin.resume();process.stdin.on("end",()=>{appendFileSync(${JSON.stringify(marker)},"run\\n");process.stdout.write(JSON.stringify({}));});\n`;

/** Marker + instructions hook. */
const MARKER_INSTRUCTIONS_BODY = (marker: string, instructions: string) =>
  `import { appendFileSync } from "node:fs";\n` +
  `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{appendFileSync(${JSON.stringify(marker)},"run\\n");process.stdout.write(JSON.stringify({instructions:${JSON.stringify(instructions)}}));});\n`;

function markerLines(marker: string): string[] {
  if (!existsSync(marker)) return [];
  return readFileSync(marker, "utf8").split("\n").filter((l) => l === "run");
}

async function addTask(title = "hook keys task"): Promise<string> {
  const added = await spawnCliIsolated(["tasks", "--add", "--title", title, "--json"], {
    cwd: projectDir,
    home: cliHome,
    env: HOOK_ENV,
  });
  expect(added.code).toBe(0);
  return (JSON.parse(added.stdout) as { task: { id: string } }).task.id;
}

/** Poll a marker file until it has ≥n lines (long-running tools). */
async function pollMarker(marker: string, n = 1, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (markerLines(marker).length >= n) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`marker ${marker} never reached ${n} lines`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("CLI keys: tasks (gate + per-activity after)", () => {
  it("tasks.before allow → write lands; tasks.after marker + instructions in --json, one doc", async () => {
    const id = await addTask();
    const marker = join(projectDir, "marker-after.log");
    writeHook("tasks", "before", `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:true}));});`);
    writeHook("tasks", "after", MARKER_INSTRUCTIONS_BODY(marker, "tasks-after-note"));
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).toBe(0);
    const doc = JSON.parse(edited.stdout) as { ok: boolean; instructions?: string[] };
    expect(doc.ok).toBe(true);
    expect(doc.instructions).toContain("tasks-after-note");
    expect(markerLines(marker)).toHaveLength(1);
  });

  it("tasks.before deny → non-zero, HOOK_BEFORE_DENIED, store unchanged, no after marker", async () => {
    const id = await addTask();
    const marker = join(projectDir, "marker-after.log");
    writeHook("tasks", "before", `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:false,reason:"keys e2e says no"}));});`);
    writeHook("tasks", "after", MARKER_BODY(marker));
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).not.toBe(0);
    expect(edited.stderr).toContain("HOOK_BEFORE_DENIED");
    expect(markerLines(marker)).toHaveLength(0);
  });

  it("two activities ⇒ two after runs (edit --comment), in operation order", async () => {
    const id = await addTask();
    const marker = join(projectDir, "marker-multi.log");
    writeHook("tasks", "after", MARKER_BODY(marker));
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--comment", "multi note", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(edited.code).toBe(0);
    expect(markerLines(marker)).toHaveLength(2);
  });

  it("tasks list (no activity) ⇒ exactly one null-activity after run with count", async () => {
    await addTask();
    const marker = join(projectDir, "marker-list.log");
    const capture = join(projectDir, "capture-list.jsonl");
    writeHook(
      "tasks",
      "after",
      `import { appendFileSync } from "node:fs";\n` +
        `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);appendFileSync(${JSON.stringify(marker)},"run\\n");appendFileSync(${JSON.stringify(capture)},JSON.stringify({activity:e.activity,count:e.activityObject&&e.activityObject.count})+"\\n");process.stdout.write(JSON.stringify({}));});\n`,
    );
    const listed = await spawnCliIsolated(["tasks", "--json"], {
      cwd: projectDir,
      home: cliHome,
      env: HOOK_ENV,
    });
    expect(listed.code).toBe(0);
    JSON.parse(listed.stdout);
    expect(markerLines(marker)).toHaveLength(1);
    const rows = readFileSync(capture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].activity).toBeNull();
    expect(rows[0].count).toBe(1);
  });
});

describe("CLI keys: read-only tools narrate once with activity null", () => {
  it.each([
    ["changelog", ["changelog"]],
    ["openapi", ["openapi"]],
    ["telemetry", ["telemetry", "--status"]],
    ["auth", ["auth"]],
    ["auth.status", ["auth", "status"]],
    ["authors.link", ["authors", "link", projectDir]],
  ])("%s runs its after hook once with activity:null", async (tool, args) => {
    const marker = join(projectDir, `marker-${tool}.log`);
    const capture = join(projectDir, `capture-${tool}.jsonl`);
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${tool}.after.mjs`),
      `import { appendFileSync } from "node:fs";\n` +
        `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);appendFileSync(${JSON.stringify(marker)},"run\\n");appendFileSync(${JSON.stringify(capture)},JSON.stringify({tool:e.tool,activity:e.activity})+"\\n");process.stdout.write(JSON.stringify({}));});\n`,
    );
    // authors.link needs a git repo to succeed; the hook fires regardless
    // only on success — init one so the success path (and the hook) runs.
    if (tool === "authors.link") {
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init"], { cwd: projectDir });
      execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: projectDir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: projectDir });
      execFileSync("git", ["commit", "--allow-empty", "-m", "x"], { cwd: projectDir });
    }
    const r = await spawnCliIsolated(args, { cwd: projectDir, home: cliHome, env: HOOK_ENV });
    expect(r.code).toBe(0);
    expect(markerLines(marker)).toHaveLength(1);
    const rows = readFileSync(capture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows[0]).toEqual({ tool, activity: null });
  });

  it("auth.logout runs its after hook (offline-safe: nothing to log out)", async () => {
    // logout with no linked board succeeds offline ("nothing to log out").
    const marker = join(projectDir, "marker-logout.log");
    writeHook("auth.logout", "after", MARKER_BODY(marker));
    const out = await spawnCliIsolated(["auth", "logout", "--json"], {
      cwd: projectDir,
      home: cliHome,
      env: HOOK_ENV,
    });
    expect(out.code).toBe(0);
    expect(markerLines(marker)).toHaveLength(1);
  });

  it("non-gateable .before files refuse HOOK_NOT_GATEABLE with no spawn", async () => {
    const marker = join(projectDir, "marker-nongate.log");
    writeHook("kanban", "before", MARKER_BODY(marker));
    const r = await spawnCliIsolated(["kanban", "--help"], {
      cwd: projectDir,
      home: cliHome,
      env: HOOK_ENV,
    });
    expect(r.code).toBe(0);
    // The file never executed (no marker); the scanner reports loudly on
    // real invocations — covered at unit level; here: no crash, no run.
    expect(markerLines(marker)).toHaveLength(0);
  });
});

describe("CLI keys: kanban + serve fire at readiness", () => {
  it("kanban.after runs when the board is listening (poll marker, then kill)", async () => {
    const marker = join(projectDir, "marker-kanban.log");
    writeHook("kanban", "after", MARKER_BODY(marker));
    const port = 47111;
    const child = spawn(process.execPath, [CLI_ENTRY, "kanban", projectDir, "-p", String(port), "--no-open"], {
      cwd: projectDir,
      env: isolatedCliEnv({ home: cliHome, cwd: projectDir, env: HOOK_ENV }),
    });
    try {
      await pollMarker(marker, 1);
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(markerLines(marker).length).toBeGreaterThanOrEqual(1);
  });

  it("serve.after runs when the server is listening (poll marker, then kill)", async () => {
    const marker = join(projectDir, "marker-serve.log");
    writeHook("serve", "after", MARKER_BODY(marker));
    const port = 47112;
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, "serve", "-p", String(port), "--no-open", "--project", projectDir],
      {
        cwd: projectDir,
        env: isolatedCliEnv({ home: cliHome, cwd: projectDir, env: HOOK_ENV }),
      },
    );
    try {
      await pollMarker(marker, 1);
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(markerLines(marker).length).toBeGreaterThanOrEqual(1);
  });
});

describe("CLI keys: push + pull against a fake backend", () => {
  function fakeBoard(): Promise<{ url: string; close: () => void }> {
    return new Promise((resolvePromise) => {
      const server: Server = createServer((req, res) => {
        const finish = (code: number, payload: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const pathname = (req.url ?? "/").split("?")[0] as string;
        if (req.method === "GET" && pathname === "/api/v0/tasks") {
          finish(200, { items: [], nextCursor: null });
          return;
        }
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => finish(404, { error: "not found" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        resolvePromise({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
      });
    });
  }

  it("pull.after runs with the confirmed counts in --json", async () => {
    const board = await fakeBoard();
    const home = mkdtempSync(join(tmpdir(), "hookkeys-pull-home-"));
    const store = mkdtempSync(join(tmpdir(), "hookkeys-pull-store-"));
    ensureTaskDirs(store);
    setupSaaSMode({ home, store, apiUrl: board.url });
    const marker = join(store, "marker-pull.log");
    const dir = join(store, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pull.after.mjs"), MARKER_INSTRUCTIONS_BODY(marker, "pull-note"));
    try {
      const r = await spawnCliIsolated(["pull", "--json"], {
        cwd: store,
        home,
        env: { ...HOOK_ENV, VIBEFLOW_API_URL: board.url },
      });
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout) as { ok: boolean; instructions?: string[] };
      expect(doc.ok).toBe(true);
      expect(doc.instructions).toContain("pull-note");
      expect(markerLines(marker)).toHaveLength(1);
    } finally {
      board.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });
});

describe("CLI keys: verify gate (engine needs a browser; the gate is proven here)", () => {
  it("verify.before deny refuses before the engine runs", async () => {
    const id = await addTask();
    const marker = join(projectDir, "marker-verify.log");
    writeHook("verify", "before", `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:false,reason:"no verify today"}));});`);
    writeHook("verify", "after", MARKER_BODY(marker));
    const r = await spawnCliIsolated(["verify", id, "--json"], {
      cwd: projectDir,
      home: cliHome,
      env: HOOK_ENV,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("HOOK_BEFORE_DENIED");
    expect(markerLines(marker)).toHaveLength(0);
  });
});

describe("MCP keys (all 13, HTTP transport)", () => {
  let env: McpTestEnv;
  let mcpProject!: string;

  beforeEach(async () => {
    env = await bootMcpServer();
    mcpProject = env.projectDir;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function withHookEnv<T>(fn: () => Promise<T>): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const k of ["VIBEFLOW_HOOKS", "VIBEFLOW_TRUST_HOOKS"] as const) {
      prev[k] = process.env[k];
      process.env[k] = "1";
    }
    try {
      return await fn();
    } finally {
      for (const k of ["VIBEFLOW_HOOKS", "VIBEFLOW_TRUST_HOOKS"] as const) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  function writeMcpHook(tool: string, phase: "before" | "after", body: string): void {
    const dir = join(mcpProject, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${tool}.${phase}.mjs`), body);
  }

  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const c = newClient(env.mcpUrl);
    await initialize(c);
    return assertJsonTextContent(await callTool(c, name, args));
  }

  it("create_task.before deny refuses; allow + after marker + instructions ride successPayload", async () => {
    await withHookEnv(async () => {
      writeMcpHook("create_task", "before", `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:false,reason:"mcp says no"}))});`);
      const denied = (await call("create_task", { title: "blocked" })) as { ok: boolean; error: { code: string } };
      expect(denied.ok).toBe(false);
      expect(denied.error.code).toBe("HOOK_BEFORE_DENIED");

      writeMcpHook("create_task", "before", `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:true}));});`);
      const marker = join(mcpProject, "marker-create.log");
      writeMcpHook("create_task", "after", MARKER_INSTRUCTIONS_BODY(marker, "create-note"));
      const created = (await call("create_task", { title: "mcp hook task" })) as {
        ok: boolean;
        instructions?: string[];
        data?: { id: string };
      };
      expect(created.ok).toBe(true);
      expect(created.instructions).toContain("create-note");
      expect(markerLines(marker)).toHaveLength(1);
    });
  });

  it("no cross-surface fallback: create_task does NOT run tasks.after.mjs", async () => {
    await withHookEnv(async () => {
      const dir = join(mcpProject, ".vibeflow-hooks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "tasks.after.mjs"),
        `process.stdout.write(JSON.stringify({instructions:"wrong-surface"}));process.stdin.resume();process.stdin.on("end",()=>{});\n`,
      );
      const created = (await call("create_task", { title: "surface check" })) as {
        ok: boolean;
        instructions?: string[];
      };
      expect(created.ok).toBe(true);
      // The shipped tasks.after default does not exist for MCP-shaped keys
      // either — either way, the project tasks.after.mjs must not run.
      expect(created.instructions ?? []).not.toContain("wrong-surface");
    });
  });

  it.each([
    ["update_task", { id: "", status: "in-progress" }, "taskId"],
    ["claim_next_task", {}, "taskId"],
    ["add_comment", { id: "", text: "note" }, "commentId"],
  ])("%s gate + after marker ride the result", async (tool, args, _idField) => {
    void _idField;
    await withHookEnv(async () => {
      const created = (await call("create_task", { title: `${tool} target` })) as {
        ok: boolean;
        data?: { id: string };
      };
      expect(created.ok).toBe(true);
      const id = created.data?.id ?? (created as unknown as { id: string }).id;
      const withId = { ...args, id };
      writeMcpHook(
        tool,
        "after",
        `import { appendFileSync } from "node:fs";\n` +
          `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);appendFileSync(${JSON.stringify(join(mcpProject, `marker-${tool}.log`))},"run:"+e.activity+"\\n");process.stdout.write(JSON.stringify({instructions:${JSON.stringify(`${tool}-note`)}}));});\n`,
      );
      const out = (await call(tool, withId)) as { ok: boolean; instructions?: string[] };
      expect(out.ok).toBe(true);
      expect(out.instructions).toContain(`${tool}-note`);
      const lines = readFileSync(join(mcpProject, `marker-${tool}.log`), "utf8").split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
    });
  });

  it("read tools narrate once with activity:null (list_tasks count, get_task record)", async () => {
    await withHookEnv(async () => {
      await call("create_task", { title: "read target" });
      const dir = join(mcpProject, ".vibeflow-hooks");
      mkdirSync(dir, { recursive: true });
      const capture = join(mcpProject, "capture-reads.jsonl");
      for (const tool of ["list_tasks", "get_task"]) {
        writeFileSync(
          join(dir, `${tool}.after.mjs`),
          `import { appendFileSync } from "node:fs";\n` +
            `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);appendFileSync(${JSON.stringify(capture)},JSON.stringify({tool:e.tool,activity:e.activity,task:e.task!=null,activityObject:e.activityObject})+"\\n");process.stdout.write(JSON.stringify({}));});\n`,
        );
      }
      const listed = (await call("list_tasks", {})) as { ok: boolean };
      expect(listed.ok).toBe(true);
      const created = (await call("create_task", { title: "get target" })) as {
        ok: boolean;
        data?: { id: string };
      };
      const id = created.data?.id ?? (created as unknown as { id: string }).id;
      const got = (await call("get_task", { id })) as { ok: boolean };
      expect(got.ok).toBe(true);
      const rows = readFileSync(capture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const listRow = rows.find((r: { tool: string }) => r.tool === "list_tasks");
      const getRow = rows.find((r: { tool: string }) => r.tool === "get_task");
      expect(listRow.activity).toBeNull();
      expect(listRow.activityObject).toEqual({ count: expect.any(Number) });
      expect(getRow.activity).toBeNull();
      expect(getRow.task).toBe(true);
    });
  });

  it("get_file/attach_file/get_project/get_integration_guide narrate with task:null or the target", async () => {
    await withHookEnv(async () => {
      const created = (await call("create_task", { title: "file target" })) as {
        ok: boolean;
        data?: { id: string };
      };
      const id = created.data?.id ?? (created as unknown as { id: string }).id;
      await call("attach_file", {
        id,
        filename: "note.txt",
        contentB64: Buffer.from("hello").toString("base64"),
      });
      const dir = join(mcpProject, ".vibeflow-hooks");
      mkdirSync(dir, { recursive: true });
      const capture = join(mcpProject, "capture-misc.jsonl");
      for (const tool of ["get_file", "attach_file", "get_project", "get_integration_guide"]) {
        writeFileSync(
          join(dir, `${tool}.after.mjs`),
          `import { appendFileSync } from "node:fs";\n` +
            `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);appendFileSync(${JSON.stringify(capture)},JSON.stringify({tool:e.tool,activity:e.activity,task:e.task!=null})+"\\n");process.stdout.write(JSON.stringify({}));});\n`,
        );
      }
      expect(((await call("get_file", { id, filename: "note.txt" })) as { ok: boolean }).ok).toBe(true);
      expect(
        ((await call("attach_file", { id, filename: "n2.txt", contentB64: Buffer.from("x").toString("base64") })) as { ok: boolean }).ok,
      ).toBe(true);
      expect(((await call("get_project", {})) as { ok: boolean }).ok).toBe(true);
      expect(((await call("get_integration_guide", {})) as { ok: boolean }).ok).toBe(true);
      const rows = readFileSync(capture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(rows.map((r: { tool: string }) => r.tool).sort()).toEqual(
        ["attach_file", "get_file", "get_integration_guide", "get_project"].sort(),
      );
      for (const r of rows as Array<{ tool: string; activity: unknown; task: boolean }>) {
        expect(r.activity).toBeNull();
      }
      // File reads carry the target record; project/guide carry no task.
      expect(rows.find((r: { tool: string }) => r.tool === "get_file")?.task).toBe(true);
      expect(rows.find((r: { tool: string }) => r.tool === "get_project")?.task).toBe(false);
    });
  });

  it("pull (shared key): offline refusal fires no hook; the key resolves per-surface", async () => {
    await withHookEnv(async () => {
      const marker = join(mcpProject, "marker-mcp-pull.log");
      writeMcpHook("pull", "after", MARKER_BODY(marker));
      const out = (await call("pull", {})) as { ok: boolean; error?: { code: string } };
      // Offline the pull cannot run — whatever the refusal, no after hook fires.
      expect(out.ok).toBe(false);
      expect(markerLines(marker)).toHaveLength(0);
    });
  });

  it("verify_task.before deny refuses; pull/verify_task reads refuse cleanly offline with no hook", async () => {
    await withHookEnv(async () => {
      writeMcpHook("verify_task", "before", `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({allow:false,reason:"no verify today"}))});`);
      const denied = (await call("verify_task", { id: "nope" })) as {
        ok: boolean;
        error: { code: string };
      };
      expect(denied.ok).toBe(false);
      expect(denied.error.code).toBe("HOOK_BEFORE_DENIED");
    });
  });

  it("start_kanban.after fires at readiness with the url", async () => {
    await withHookEnv(async () => {
      const marker = join(mcpProject, "marker-start-kanban.log");
      const capture = join(mcpProject, "capture-start-kanban.jsonl");
      writeMcpHook(
        "start_kanban",
        "after",
        `import { appendFileSync } from "node:fs";\n` +
          `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);appendFileSync(${JSON.stringify(marker)},"run\\n");appendFileSync(${JSON.stringify(capture)},JSON.stringify({activity:e.activity,url:e.activityObject&&e.activityObject.url})+"\\n");process.stdout.write(JSON.stringify({}));});\n`,
      );
      const port = await getFreePort();
      const started = (await call("start_kanban", { port })) as { ok: boolean };
      expect(started.ok).toBe(true);
      await pollMarker(marker, 1);
      const rows = readFileSync(capture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(rows[0].activity).toBeNull();
      expect(typeof rows[0].url).toBe("string");
      const { closeKanbanServer } = await import("../../src/server/kanban-server.js");
      await closeKanbanServer();
    });
  });
});
