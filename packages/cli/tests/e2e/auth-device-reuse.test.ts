/**
 * CLI e2e — device-login reuse shape (ticket 64204dec).
 *
 * Regression test for exactly this bug: with a live token for the
 * machine, the server answers device-poll with
 * `{ reused: true, tokenId, name }` instead of minting. The pre-fix CLI
 * did not know that shape, treated it as "pending", and died on the next
 * poll with a misleading "Device code expired" — permanently, because
 * every later attempt takes the reuse path too.
 *
 * Two flows against a local stub (no network beyond localhost):
 * - no local credential → the CLI requests a fresh PAT
 *   (`{ deviceCode, rotate: true }`), the stub mints, and the credential
 *   lands in the project-scoped store (ADR-0005);
 * - live local credential → the CLI adopts the existing link (writes the
 *   project pointer) and mints nothing.
 *
 * Red proof: on the pre-fix build both tests fail — the CLI never sends
 * `rotate: true`, writes no credential, and exits with "expired"/timeout.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
// Module-anchored CLI entry (never process.cwd()); HOME isolation via
// isolatedCliEnv — never the operator's real HOME.
import { CLI_ENTRY as CLI_PATH } from "./spawn-isolated.js";
import { isolatedCliEnv } from "./spawn-isolated.js";
import { setupSaaSMode } from "../helpers/saas-auth.js";

process.env.VIBEFLOW_TELEMETRY = "0";

const FRESH_TOKEN = "vbf_pat_reuse01FreshSecretFreshSecretFreshSecret12";
const LIVE_TOKEN = "vbf_pat_reuse02LiveSecretLiveSecretLiveSecretLive34";
const BOARD = { id: "board-reuse", name: "Reuse Board", slug: "reuse", role: "owner" };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface PollSeen {
  body: Record<string, unknown>;
}

interface Stub {
  url: string;
  polls: PollSeen[];
  tokensMinted: number;
}

/**
 * Stub v0 backend for the reuse flow. Plain polls answer the reuse shape
 * (the bug's trigger); a poll carrying `rotate: true` mints exactly one
 * fresh PAT. Every non-device route needs the right Bearer token.
 */
async function startReuseStub(opts?: { liveTokenValid?: boolean }): Promise<Stub> {
  const liveTokenValid = opts?.liveTokenValid ?? true;
  const polls: PollSeen[] = [];
  let tokensMinted = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const finish = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/api/v0/auth/device-init") {
      finish(200, {
        deviceCode: "reuse-dev-code",
        userCode: "REUSE-1",
        verificationUrl: "http://127.0.0.1/reuse-verify",
        // Just past the post-fix completion time (~5s: one 3s poll
        // interval plus the rotate round-trip), so the pre-fix build
        // still dies fast (pending-dots until the deadline) instead of
        // hanging the suite on its 10-minute production expiry.
        expiresIn: 12,
      });
      return;
    }
    if (req.method === "POST" && url === "/api/v0/auth/device-poll") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const parsed = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
        polls.push({ body: parsed });
        if (parsed.rotate === true) {
          tokensMinted++;
          finish(200, { token: FRESH_TOKEN });
          return;
        }
        finish(200, { reused: true, tokenId: "pat-live", name: "field-box (Linux)" });
      });
      return;
    }
    const authedFresh = req.headers.authorization === `Bearer ${FRESH_TOKEN}`;
    const authedLive = req.headers.authorization === `Bearer ${LIVE_TOKEN}`;
    if (req.method === "GET" && url === "/api/v0/me") {
      // The stored-token liveness probe: only the live token passes, and
      // only when the stub says it is still valid.
      if (authedLive && liveTokenValid) {
        finish(200, { id: "user_reuse", name: "Reuse", email: "reuse@example.com", image: null });
        return;
      }
      finish(401, { error: "unauthorized", code: "UNAUTHENTICATED" });
      return;
    }
    if (!authedFresh && !(authedLive && liveTokenValid)) {
      finish(401, { error: "unauthorized", code: "UNAUTHENTICATED" });
      return;
    }
    if (req.method === "GET" && url === "/api/v0/boards") {
      finish(200, { items: [BOARD], nextCursor: null });
      return;
    }
    if (req.method === "GET" && url === "/api/v0/settings") {
      finish(200, { settings: {} });
      return;
    }
    finish(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    polls,
    get tokensMinted() {
      return tokensMinted;
    },
  };
}

function spawnLogin(
  store: string,
  home: string,
  apiUrl: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_PATH, "login"], {
      cwd: store,
      env: {
        ...isolatedCliEnv({ home, cwd: store }),
        VIBEFLOW_NO_BROWSER: "1",
        VIBEFLOW_API_URL: apiUrl,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    // Decline the post-login local-push prompt (no local tasks seeded).
    child.stdin.write("n\n");
    child.stdin.end();
  });
}

/** A resolvable project (ADR-0005): the CLI refuses outside one. */
function makeProject(): string {
  const dir = freshDir("reuse-store-");
  mkdirSync(join(dir, ".vibeflow"), { recursive: true });
  writeFileSync(join(dir, ".vibeflow", "settings.json"), "{}");
  return dir;
}

function readCredential(home: string, apiUrl: string): Record<string, unknown> | null {
  const path = join(home, ".vibeflow", "credentials.json");
  if (!existsSync(path)) return null;
  const all = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  return (all[apiUrl] as Record<string, unknown> | undefined) ?? null;
}

describe("device login against the reuse shape (ticket 64204dec)", () => {
  it("no local credential → rotates to a fresh PAT and completes the login", async () => {
    const store = makeProject();
    const home = freshDir("reuse-home-");
    const stub = await startReuseStub();

    const r = await spawnLogin(store, home, stub.url);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Logged in successfully. Now operating in online mode.");
    expect(r.stdout + r.stderr).not.toContain("Device code expired");
    // The fresh-PAT path: exactly one rotate request, exactly one mint.
    expect(stub.polls.some((p) => p.body.rotate === true)).toBe(true);
    expect(stub.tokensMinted).toBe(1);
    // The new credential lands in the project-scoped store (ADR-0005).
    const cred = readCredential(home, stub.url);
    expect(cred?.token).toBe(FRESH_TOKEN);
    expect(cred?.workspaceId).toBe(BOARD.id);
    // A successful login leaves the board linked.
    const pointer = JSON.parse(
      readFileSync(join(store, ".vibeflow", "settings.json"), "utf-8"),
    ) as { workspace?: { apiUrl: string; id: string } };
    expect(pointer.workspace?.id).toBe(BOARD.id);
  }, 90_000);

  it("live local credential → adopts the existing link and mints nothing", async () => {
    const store = makeProject();
    const home = freshDir("reuse-home-");
    const stub = await startReuseStub();
    // Seed the user-scoped store exactly as a previous login left it.
    setupSaaSMode({
      home,
      store,
      apiUrl: stub.url,
      token: LIVE_TOKEN,
      workspaceId: BOARD.id,
      account: "reuse@example.com",
    });

    const r = await spawnLogin(store, home, stub.url);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Logged in successfully. Now operating in online mode.");
    expect(r.stdout).toMatch(/existing token/i);
    expect(r.stdout + r.stderr).not.toContain("Device code expired");
    // Adopt, not mint: no rotate request, no fresh PAT handed out.
    expect(stub.polls.some((p) => p.body.rotate === true)).toBe(false);
    expect(stub.tokensMinted).toBe(0);
    // The stored secret is untouched; the project pointer is written.
    expect(readCredential(home, stub.url)?.token).toBe(LIVE_TOKEN);
    const pointer = JSON.parse(
      readFileSync(join(store, ".vibeflow", "settings.json"), "utf-8"),
    ) as { workspace?: { apiUrl: string; id: string } };
    expect(pointer.workspace?.id).toBe(BOARD.id);
  }, 90_000);
});
