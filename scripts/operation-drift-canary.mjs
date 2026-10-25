#!/usr/bin/env node
/**
 * Scheduled/low-frequency drift canary (P9, ticket 0e5f5e06).
 *
 * Black-box check that the CLI binary and the MCP server still agree on the
 * SAME disposable board: it spawns the built CLI
 * (`packages/cli/dist/index.js`) and speaks MCP over stdio to
 * `node dist/index.js mcp --project <dir>`, then compares normalized
 * list/get/create/update/comment/claim-preview/refusal results. Any
 * divergence fails loudly (nonzero exit + JSON report naming the differing
 * paths) — a green run means the two renderers still share one operation
 * layer, not merely that both start.
 *
 * Usage:
 *   node scripts/operation-drift-canary.mjs --lane local [--root /tmp/x]
 *   node scripts/operation-drift-canary.mjs --lane hosted   # follow-up lane
 *
 * Lanes:
 *   local  — fully implemented here: disposable /tmp board, isolated HOME,
 *            no network, no credentials. This is what the daily schedule
 *            runs (see .github/workflows/differential-canary.yml).
 *   hosted — FOLLOW-UP (not implemented in this repo): same comparisons
 *            against a disposable cloud board through hosted MCP + the v0
 *            API. Anchors for the follow-up:
 *              - disposable board setup: POST /api/v0/tasks (bulk import)
 *                with a PAT scoped to a throwaway account; teardown DELETEs
 *                the board (see private web package api routes);
 *              - hosted MCP transport: wss/HTTPS /mcp endpoint with the
 *                same PAT as Bearer (see private cloud-tools RUNNERS);
 *              - compare with the SAME normalizer below (ids/order/counts,
 *                never board-vs-filesystem paths: hosted get_project
 *                answers board identity per KNOWN_DELTAS
 *                hosted-project-identity);
 *              - refusal contract: hosted verify_task answers
 *                VERIFY_ENGINE_LOCAL_ONLY; pull is absent on hosted
 *                (KNOWN_DELTAS hosted-pull-absent / hosted-verify-local-only).
 *            Until that lane exists the script REFUSES --lane hosted with
 *            exit 2 and says so — never a silent skip, never a fake green.
 *
 * Safety: refuses a --root outside /tmp (never the operator's checkout);
 * kills the MCP child (stdin EOF → transport closes → process exits);
 * removes the disposable root and HOME; never touches ~/.vibeflow.
 */
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI = join(REPO_ROOT, "packages/cli/dist/index.js");
const PROTOCOL_VERSION = "2025-06-18";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.findIndex((a) => a === name || a.startsWith(name + "="));
  if (i === -1) return def;
  const a = args[i];
  if (a.includes("=")) return a.slice(name.length + 1);
  const next = args[i + 1];
  if (next !== undefined && !next.startsWith("--")) return next;
  return true;
};
const lane = flag("--lane", "local");
const reportPath = flag("--report", null);

if (lane === "hosted") {
  console.error(
    JSON.stringify(
      {
        ok: false,
        lane: "hosted",
        error: {
          code: "FOLLOW_UP_NOT_IMPLEMENTED",
          message:
            "The hosted disposable-board lane is the P9 follow-up (see script header anchors). " +
            "Refusing instead of silently skipping or faking green.",
        },
      },
      null,
      2,
    ),
  );
  process.exit(2);
}
if (lane !== "local") {
  console.error(`unknown --lane "${lane}" (want local|hosted)`);
  process.exit(2);
}

let ROOT = flag("--root", null);
if (ROOT === null) ROOT = mkdtempSync(join(tmpdir(), "vf-canary-"));
if (!ROOT.startsWith("/tmp/")) {
  console.error(`refusing --root outside /tmp: ${ROOT}`);
  process.exit(2);
}
const HOME = mkdtempSync(join(tmpdir(), "vf-canary-home-"));
const failures = [];
const notes = [];
const note = (m) => notes.push(m);
const fail = (path, cliVal, mcpVal) =>
  failures.push({ path, cli: cliVal, mcp: mcpVal });

// Isolated child env (ticket 8ac96ef9): temp HOME, no GIT_* inheritance
// (hook context would hijack the child's cwd), no redirect inheritance
// (VIBEFLOW_API_URL / VIBEFLOW_PROJECT_DIR would aim the child elsewhere),
// ceiling pinned at the disposable root. Mirrors
// packages/cli/tests/e2e/spawn-isolated.ts (this script is .mjs and cannot
// import it); tests/unit/cli-spawn-guard.test.ts trips if this block regresses.
function isolatedEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "HOME") continue;
    if (key.startsWith("GIT_")) continue;
    if (
      (key === "VIBEFLOW_API_URL" || key === "VIBEFLOW_PROJECT_DIR") &&
      !(key in extra)
    )
      continue;
    env[key] = value;
  }
  env.HOME = HOME;
  env.VIBEFLOW_TELEMETRY = "0";
  env.GIT_CEILING_DIRECTORIES = ROOT;
  return { ...env, ...extra };
}

function runCliFn(cliArgs, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [CLI, ...cliArgs],
      {
        cwd: ROOT,
        timeout: 20000,
        env: isolatedEnv(),
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        if (!allowFail && code !== 0) {
          reject(
            new Error(`cli ${cliArgs.join(" ")} exited ${code}: ${stderr}`),
          );
          return;
        }
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const cliJson = async (...cliArgs) => {
  const res = await runCliFn(cliArgs, { allowFail: true });
  const raw = res.code === 0 ? res.stdout : res.stderr;
  return { code: res.code, body: JSON.parse(raw) };
};

// ── minimal MCP stdio client (newline-delimited JSON-RPC) ──
function startMcp() {
  const child = spawn("node", [CLI, "mcp", "--project", ROOT], {
    env: isolatedEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`mcp ${method} timed out. stderr: ${stderr}`));
        }
      }, 20000);
    });
  return {
    send,
    async call(tool, toolArgs) {
      const msg = await send("tools/call", {
        name: tool,
        arguments: toolArgs,
      });
      if (msg.error)
        throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
      const text = msg.result?.content?.[0]?.text;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`non-JSON tool text for ${tool}: ${text}`);
      }
    },
    async stop() {
      child.stdin.end();
      await new Promise((r) => child.on("exit", r));
    },
  };
}

const sortedIds = (tasks) => tasks.map((t) => t.id).sort();
const normTask = (t) => ({
  id: t.id,
  title: t.title,
  description: t.description,
  status: t.status,
  links: (t.links ?? []).map((l) => ({ ...l })),
  comments: (t.comments ?? []).map((c) => c.text),
  files: (t.files ?? []).map((f) => ({ name: f.name, size: f.size })),
});

let mcp = null;
async function main() {
  note(`target fingerprint: root=${ROOT} cli=${CLI}`);
  // Seed through the CLI first: the CLI creates the .vibeflow/ store, which
  // the MCP server requires before it will start in the directory.
  for (const [title, extra] of [
    ["canary-a", ["--priority", "High"]],
    ["canary-b", []],
  ]) {
    const r = await cliJson("tasks", "--add", "--title", title, ...extra, "--json");
    if (r.code !== 0) fail(`seed ${title}`, r, "exit 0");
  }
  mcp = startMcp();
  const hello = await mcp.send("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "drift-canary", version: "0.0.0" },
  });
  if (!hello.result?.serverInfo) fail("initialize.serverInfo", null, hello);
  else note(`server ${hello.result.serverInfo.name}@${hello.result.serverInfo.version}`);
  const tools = await mcp.send("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
  const expected = [
    "add_comment",
    "attach_file",
    "claim_next_task",
    "create_task",
    "get_integration_guide",
    "get_project",
    "get_task",
    "list_tasks",
    "pull",
    "start_kanban",
    "update_task",
    "verify_task",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail("tools/list", names, expected);
  }

  // Reads: roots, filtered scope, detail.
  const cliRoots = await cliJson("tasks", "--json");
  const mcpRoots = await mcp.call("list_tasks", {});
  if (JSON.stringify(sortedIds(cliRoots.body.tasks)) !== JSON.stringify(sortedIds(mcpRoots.tasks))) {
    fail("list.roots", sortedIds(cliRoots.body.tasks), sortedIds(mcpRoots.tasks));
  }
  if (mcpRoots.totalMatching !== cliRoots.body.totalMatching) {
    fail("list.totalMatching", cliRoots.body.totalMatching, mcpRoots.totalMatching);
  }
  const cliF = await cliJson("tasks", "--status", "todo", "--json");
  const mcpF = await mcp.call("list_tasks", { status: "todo" });
  if (JSON.stringify(sortedIds(cliF.body.tasks)) !== JSON.stringify(sortedIds(mcpF.tasks))) {
    fail("list.filtered", sortedIds(cliF.body.tasks), sortedIds(mcpF.tasks));
  }
  for (const id of sortedIds(mcpRoots.tasks)) {
    const g = await cliJson("tasks", "--get", id, "--json");
    const m = await mcp.call("get_task", { id });
    const a = normTask(g.body.task);
    const b = normTask(m);
    if (JSON.stringify(a) !== JSON.stringify(b)) fail(`get.${id}`, a, b);
  }

  // Mutations cross-read through the other surface.
  const created = await cliJson("tasks", "--add", "--title", "canary-cli", "--json");
  const viaMcp = await mcp.call("get_task", { id: created.body.task.id });
  if (viaMcp.title !== "canary-cli") fail("create.cli->mcp", "canary-cli", viaMcp.title);
  const mcpMade = await mcp.call("create_task", { title: "canary-mcp" });
  const viaCli = await cliJson("tasks", "--get", mcpMade.id, "--json");
  if (viaCli.body.task.title !== "canary-mcp") fail("create.mcp->cli", "canary-mcp", viaCli.body.task.title);
  await mcp.call("update_task", { id: mcpMade.id, comment: "canary note" });
  const viaCli2 = await cliJson("tasks", "--get", mcpMade.id, "--json");
  const texts = (viaCli2.body.task.comments ?? []).map((c) => c.text);
  if (!texts.includes("canary note")) fail("comment.mcp->cli", texts, ["canary note"]);

  // Claim preview agrees on an unchanged snapshot.
  const cliPrev = await cliJson("tasks", "--next", "--dry-run", "--json");
  const mcpPrev = await mcp.call("claim_next_task", { dryRun: true });
  if ((cliPrev.body.task?.id ?? null) !== (mcpPrev.id ?? null)) {
    fail("claim.preview", cliPrev.body.task?.id ?? null, mcpPrev.id ?? null);
  }

  // Refusals agree and write nothing.
  const cliMiss = await cliJson("tasks", "--get", "deadbeef", "--json");
  const mcpMiss = await mcp.call("get_task", { id: "deadbeef" });
  if (cliMiss.body?.error?.code !== "TASK_NOT_FOUND") fail("refusal.cli", cliMiss.body, "TASK_NOT_FOUND");
  if (mcpMiss?.error?.code !== "TASK_NOT_FOUND") fail("refusal.mcp", mcpMiss, "TASK_NOT_FOUND");

  const ok = failures.length === 0;
  const report = {
    ok,
    lane: "local",
    fingerprint: { root: ROOT, cli: CLI },
    failures,
    notes,
  };
  console.log(JSON.stringify(report, null, 2));
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  process.exit(ok ? 0 : 1);
}

try {
  await main();
} catch (err) {
  console.log(
    JSON.stringify({ ok: false, lane: "local", fatal: String(err?.stack ?? err) }, null, 2),
  );
  process.exit(1);
} finally {
  try {
    await mcp?.stop();
  } catch {}
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  if (existsSync(HOME)) rmSync(HOME, { recursive: true, force: true });
}
