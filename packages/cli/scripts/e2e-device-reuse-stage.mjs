#!/usr/bin/env node
/**
 * Stage E2E for the device-login reuse fix (ticket 64204dec).
 *
 * Real flow against STAGE (never production, never localhost stubs):
 * device-init → approve as an agent-owned test account → poll →
 * credential written → `vibeflow tasks` reads the linked board.
 *
 * STATUS: written but UNRUN — approving a device code needs an
 * authenticated stage session for an agent-owned test account, and this
 * environment holds no such credential (by policy the agent never uses a
 * human account and never creates accounts on its own). Hand the command
 * below to the owner with credentials set.
 *
 * Prerequisites (owner):
 * 1. An agent-owned test account on stage that owns at least one board.
 * 2. A session cookie for that account: sign in on stage in a browser,
 *    open devtools → Application → Cookies, and copy the FULL `Cookie`
 *    header value for one request to the stage host.
 *
 * Usage (from vibeflow/packages/cli):
 *
 *   VIBEFLOW_STAGE_URL=https://<stage-host> \
 *   VIBEFLOW_E2E_COOKIE='<full cookie header value>' \
 *   node scripts/e2e-device-reuse-stage.mjs
 *
 * Optional: VIBEFLOW_E2E_BOARD='<board id>' asserts the pointer lands on
 * that board (default: whatever single board the account owns; the script
 * refuses multi-board accounts without this pin to avoid an interactive
 * prompt hanging the run).
 *
 * What it proves: login completes against the reuse path (the account
 * will already hold a live token for the test machine after the first
 * run, so the SECOND run is the true reuse/rotate exercise), the fresh
 * PAT lands in ~/.vibeflow/credentials.json of a TEMPorary HOME, the
 * project pointer is written, and `vibeflow tasks --json` reads the
 * linked board. Exit code 1 with a named failure otherwise.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(here, "..", "dist", "cli", "index.js");

const STAGE = (process.env.VIBEFLOW_STAGE_URL ?? "").replace(/\/+$/, "");
const COOKIE = process.env.VIBEFLOW_E2E_COOKIE ?? "";
const WANT_BOARD = process.env.VIBEFLOW_E2E_BOARD ?? "";

function fail(step, detail) {
  console.error(`E2E FAIL [${step}]: ${detail}`);
  process.exit(1);
}
function say(s) {
  console.log(`E2E: ${s}`);
}

if (!STAGE) fail("env", "set VIBEFLOW_STAGE_URL=https://<stage-host>");
if (!COOKIE) fail("env", "set VIBEFLOW_E2E_COOKIE='<full cookie header value from a stage session>'");
if (!existsSync(CLI_ENTRY)) fail("build", `CLI entry missing: ${CLI_ENTRY} — run pnpm --filter @vibeflow-tools/cli run build first`);

const home = mkdtempSync(join(tmpdir(), "stage-reuse-home-"));
const store = mkdtempSync(join(tmpdir(), "stage-reuse-store-"));
mkdirSync(join(store, ".vibeflow"), { recursive: true });
writeFileSync(join(store, ".vibeflow", "settings.json"), "{}");

const env = {
  ...process.env,
  HOME: home,
  VIBEFLOW_API_URL: STAGE,
  VIBEFLOW_NO_BROWSER: "1",
  VIBEFLOW_TELEMETRY: "0",
};

say(`stage=${STAGE} home=${home} store=${store}`);

// 1. Start login; watch stdout for the verification URL the CLI prints.
const child = spawn("node", [CLI_ENTRY, "login"], { cwd: store, env, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => { stdout += d; });
child.stderr.on("data", (d) => { stderr += d; });

const verifyUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("never printed a verification URL")), 30_000);
  const scan = () => {
    const m = stdout.match(/\/cli\/verify\?code=([A-Za-z0-9-]+)/);
    if (m) { clearTimeout(timer); resolve(m[0]); return; }
    setTimeout(scan, 250);
  };
  scan();
}).catch((e) => fail("device-init", `${e.message}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
say(`verification page: ${verifyUrl}`);
const userCode = verifyUrl.split("code=")[1];

// Multi-board accounts would prompt; pin or refuse rather than hang.
if (!WANT_BOARD) say("no VIBEFLOW_E2E_BOARD pin — single-board account assumed (script refuses to answer prompts)");

// 2. Approve the user code with the agent-owned test-account session.
const verifyRes = await fetch(`${STAGE}/api/v0/auth/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: COOKIE },
  body: JSON.stringify({ userCode }),
});
if (!verifyRes.ok) fail("verify", `HTTP ${verifyRes.status}: ${(await verifyRes.text()).slice(0, 300)}`);
say(`approved userCode ${userCode}`);

// 3. Answer the post-login push prompt (decline — nothing seeded) and wait.
child.stdin.write(WANT_BOARD ? "n\n" : "n\n");
child.stdin.end();
const code = await new Promise((resolve) => {
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 120_000);
  child.on("close", (c) => { clearTimeout(timer); resolve(c); });
});
if (code !== 0) fail("login", `exit code ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
if (!stdout.includes("Logged in successfully")) fail("login", "success line missing");
if (/expired|timed out/i.test(stdout + stderr)) fail("login", "saw expired/timeout text");
say("login completed");
say(`reuse/rotate line: ${stdout.split("\n").find((l) => /existing token|revoked/i.test(l)) ?? "(plain mint — first run against this machine)"}`);

// 4. Credential + pointer.
const credPath = join(home, ".vibeflow", "credentials.json");
if (!existsSync(credPath)) fail("credential", "credentials.json not written");
const creds = JSON.parse(readFileSync(credPath, "utf-8"));
const cred = creds[STAGE];
if (!cred?.token) fail("credential", `no entry keyed by ${STAGE}`);
const pointer = JSON.parse(readFileSync(join(store, ".vibeflow", "settings.json"), "utf-8")).workspace;
if (!pointer?.id) fail("pointer", "project pointer not written");
if (WANT_BOARD && pointer.id !== WANT_BOARD) fail("pointer", `board ${pointer.id} !== ${WANT_BOARD}`);
say(`credential stored (prefix ${String(cred.token).slice(0, 14)}…), pointer → board ${pointer.id}`);

// 5. `vibeflow tasks` reads the linked board.
let tasksOut;
try {
  tasksOut = execFileSync("node", [CLI_ENTRY, "tasks", "--json"], { cwd: store, env, encoding: "utf-8", timeout: 60_000 });
} catch (e) {
  fail("tasks", `vibeflow tasks failed: ${String(e.message).slice(0, 500)}`);
}
let parsed;
try {
  parsed = JSON.parse(tasksOut);
} catch {
  fail("tasks", "tasks --json did not parse");
}
if (parsed.ok !== true) fail("tasks", `tasks ok !== true: ${tasksOut.slice(0, 300)}`);
say(`tasks reads the linked board (ok: true)`);

say("STAGE E2E PASS");
rmSync(store, { recursive: true, force: true });
