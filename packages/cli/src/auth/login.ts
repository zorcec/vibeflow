import chalk from "chalk";
import open from "open";
import readline from "node:readline";
import select from "@inquirer/select";
import { readCredential, writeCredential } from "./credentials.js";
import { getDeviceName, getMachineId } from "./machine.js";
import type { WorkspaceInfo } from "./workspace.js";
import { resolveProjectAuth } from "./project-auth.js";
import { readProjectPointer, writeProjectPointer } from "./project-pointer.js";
import { writeGlobalSettings, type ProtoSettings } from "../core/settings.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROTO_DIR, TASKS_DIR } from "../core/types.js";
import { ExitCode } from "../core/exit-codes.js";
import { getApiUrl, surfacePath } from "../core/api-url.js";
import { fetchWithTimeout } from "../saas/request.js";
import { scopeHeaderFor } from "./board-scope.js";
import {
  acquirePreflightLease,
  fingerprintSettings,
  identityHashFor,
  persistPreflightState,
  readPreflightState,
  readSettingsParts,
} from "./settings-preflight-state.js";

/**
 * Settings pre-flight (ticket cca4bfe4, persistence ticket d5178789):
 * content-hash revision, 5-minute debounce, fail-open.
 *
 * - WHAT: `{ identityHash, hash, checkedAt, fingerprint }` in module
 *   memory PLUS a tiny stamp on disk
 *   (`<project>/.vibeflow-state/settings-preflight.json` — an UNSYNCED
 *   runtime dir, never the synced store, no secrets, no settings payload).
 *   On command start, a check older than 5 min revalidates with a
 *   conditional GET (`If-None-Match: <hash>`) on the EXISTING settings
 *   endpoint — no second round-trip. 304 (unchanged) → nothing else
 *   happens; 200 with a new hash → merge once and store the new stamp.
 * - WHY persisted (d5178789, reversing the old memory-only policy): every
 *   CLI command is a fresh process, so memory-only meant EVERY invocation
 *   re-checked (51 settings requests in 25 min). The disk stamp is keyed
 *   by account/token/API (identityHash) and bound to the settings bytes
 *   actually present (fingerprint), so a stale stamp can neither leak
 *   across accounts nor mask an independently changed/deleted cache —
 *   at most one tiny request per 5 minutes per project, zero in-window.
 * - TIMEOUT 3000 ms (agent decision, ticket cca4bfe4): fail-open bound so
 *   an unreachable server delays a command by at most one short timeout —
 *   measured ~0 ms added on the cached path (no request at all).
 * - Errors (timeout, non-ok, unreachable) keep cached settings, never
 *   throw, and still advance checkedAt: backing off avoids hammering a
 *   down server once per command in long-lived processes (serve/kanban).
 * - Checked at command start only (`src/index.ts` top level) — never
 *   mid-write, so a refresh can never interleave with a settings write.
 * - Concurrent invocations race for a non-blocking lease: the winner
 *   refreshes, losers continue with current settings (never wait).
 */
const SETTINGS_PREFLIGHT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SETTINGS_PREFLIGHT_TIMEOUT_MS = 3000;

interface SettingsPreflight {
  identityHash: string;
  fingerprint: string;
  hash: string | null;
  checkedAt: number;
}

let preflight: SettingsPreflight | null = null;

/** Test seam: drop the in-memory pre-flight state (disk state untouched). */
export function resetSettingsPreflight(): void {
  preflight = null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function promptWorkspaceSelection(
  workspaces: WorkspaceInfo[],
): Promise<WorkspaceInfo> {
  if (workspaces.length === 1) {
    // Stryker disable once StringLiteral: display message for workspace selection
    console.log(
      chalk.dim(
        `  Using board: ${workspaces[0]!.icon ?? ""} ${workspaces[0]!.name}`,
      ),
    );
    return workspaces[0]!;
  }

  const chosen = await select({
    // Stryker disable once StringLiteral: display message for workspace selection
    message: "Select a board to use:",
    choices: workspaces.map((ws) => ({
      // Stryker disable once StringLiteral: display name for workspace selection
      name: `${ws.icon ?? ""} ${ws.name}`,
      value: ws,
    })),
  });
  return chosen;
}

async function fetchAndApplySettings(
  apiUrl: string,
  token: string,
  projectDir?: string,
): Promise<void> {
  try {
    // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
    // pi-lens-ignore: ts-ssrf — apiUrl validated by getApiUrl(), path constant
    const res = await fetchWithTimeout(`${apiUrl}${surfacePath("cloud", "/api/cli/settings")}`, {
      headers: { Authorization: `Bearer ${token}` },
    }, { phase: "plan-preflight (settings)", timeoutMs: SETTINGS_PREFLIGHT_TIMEOUT_MS });
    if (!res.ok) return;
    const data = (await res.json()) as { settings: ProtoSettings };
    if (data.settings && Object.keys(data.settings).length > 0) {
      writeGlobalSettings({ ...data.settings });
    }
    // Ticket d5178789: login just performed the real sync, so publish
    // its stamp — the next command must not re-fetch what login already
    // reconciled. Never throws; a failed publish only costs one refresh.
    if (projectDir !== undefined) {
      const parts = readSettingsParts(projectDir);
      persistPreflightState(projectDir, {
        identityHash: identityHashFor(apiUrl, token),
        checkedAt: Date.now(),
        settingsHash: null,
        settingsFingerprint: fingerprintSettings(parts.global, parts.project),
      });
    }
    resetSettingsPreflight();
  } catch {
    // Non-critical
  }
}

/**
 * Ticket d5178789: debounced settings refresh that spans CLI invocations.
 *
 * `projectDir` selects the project-local state dir. It is OPTIONAL for
 * backward compatibility: callers that pass none (unit tests, introspection
 * paths) keep the legacy in-memory-only debounce. Production startup
 * (`src/index.ts`) passes `process.cwd()` so every invocation of the same
 * project shares one 5-minute window — zero in-window settings requests.
 * (A future resolved-command hook can pass the command's target project
 * instead of cwd; the parameter is already in place for it.)
 */
export async function maybeRefreshSettings(now: number = Date.now(), projectDir?: string): Promise<void> {
  try {
    // Project-scoped (ADR-0005): the pre-flight only runs for a known
    // project, using that project's credential — never a global token.
    const token = projectDir !== undefined
      ? (await resolveProjectAuth(projectDir)).token
      : null;
    // No token: no fetch and no state/lease creation (offline stays offline).
    if (!token) return;
    const apiUrl = getApiUrl();
    const identityHash = identityHashFor(apiUrl, token);
    const parts = projectDir !== undefined ? readSettingsParts(projectDir) : null;
    const fingerprint = parts !== null
      ? fingerprintSettings(parts.global, parts.project)
      : "memory-only";
    const fresh = (checkedAt: number): boolean =>
      checkedAt <= now && now - checkedAt < SETTINGS_PREFLIGHT_INTERVAL_MS;
    // In-memory fast path (long-lived processes: MCP server, serve): the
    // stamp is keyed by identity+fingerprint, so an account switch or an
    // independent settings edit re-arms eligibility instead of serving
    // another identity's window.
    if (
      preflight !== null &&
      preflight.identityHash === identityHash &&
      preflight.fingerprint === fingerprint &&
      fresh(preflight.checkedAt)
    ) {
      return;
    }
    const disk = projectDir !== undefined ? readPreflightState(projectDir) : null;
    if (
      disk !== null &&
      disk.identityHash === identityHash &&
      disk.settingsFingerprint === fingerprint &&
      fresh(disk.checkedAt)
    ) {
      // Cross-process debounce hit: another invocation already refreshed
      // inside this window — ZERO requests. Adopt the stamp in memory.
      preflight = {
        identityHash,
        fingerprint,
        hash: disk.settingsHash,
        checkedAt: disk.checkedAt,
      };
      return;
    }
    const hash = disk?.identityHash === identityHash && disk?.settingsFingerprint === fingerprint
      ? disk.settingsHash
      : (preflight?.identityHash === identityHash && preflight?.fingerprint === fingerprint
        ? preflight.hash
        : null);
    // A hash without a bound cache must not ride as If-None-Match: 304 is
    // only usable when the bytes it describes are actually present.
    const cachePresent = parts === null ||
      parts.global !== "#missing" ||
      parts.project !== "#missing";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (hash && cachePresent) headers["If-None-Match"] = `"${hash}"`;
    const remember = (nextHash: string | null, checkedAt: number): void => {
      preflight = { identityHash, fingerprint, hash: nextHash, checkedAt };
      if (projectDir !== undefined) {
        persistPreflightState(projectDir, {
          identityHash,
          checkedAt,
          settingsHash: nextHash,
          settingsFingerprint: fingerprint,
        });
      }
    };
    // One refresh per window per project: the lease winner fetches, losers
    // keep current settings and continue WITHOUT waiting. No project dir
    // (legacy callers) means no lease — fetch directly like before.
    if (projectDir !== undefined) {
      const lease = acquirePreflightLease(projectDir, now);
      if (!lease.held) return;
      try {
        // Re-read after acquisition: another process may have refreshed
        // while we raced for the lease — adopt instead of re-fetching.
        const raced = readPreflightState(projectDir);
        if (
          raced !== null &&
          raced.identityHash === identityHash &&
          raced.settingsFingerprint === fingerprint &&
          fresh(raced.checkedAt)
        ) {
          preflight = {
            identityHash,
            fingerprint,
            hash: raced.settingsHash,
            checkedAt: raced.checkedAt,
          };
          return;
        }
        await refreshSettingsOnce(apiUrl, headers, hash, projectDir, fingerprint, remember, now);
      } finally {
        lease.release();
      }
      return;
    }
    await refreshSettingsOnce(apiUrl, headers, hash, projectDir, fingerprint, remember, now);
  } catch {
    // Non-critical
  }
}

/**
 * One bounded conditional refresh. `sentHash` is the ETag the request
 * carried (if any) — failures back off on it without re-reading headers.
 * On 200 the fingerprint is re-read BEFORE applying: a local/global edit
 * that landed mid-flight invalidates instead of being overwritten and
 * re-stamped fresh — the next invocation stays eligible.
 */
async function refreshSettingsOnce(
  apiUrl: string,
  headers: Record<string, string>,
  sentHash: string | null,
  projectDir: string | undefined,
  fingerprint: string,
  remember: (nextHash: string | null, checkedAt: number) => void,
  now: number,
): Promise<void> {
  let res: Response;
  try {
    // pi-lens-ignore: ts-ssrf — apiUrl validated by getApiUrl(), path constant
    // Whole-body bound (ticket d13fa9f5): the old headers-only abort
    // left a stalled settings body unbounded; same 3s budget, now total.
    res = await fetchWithTimeout(`${apiUrl}${surfacePath("cloud", "/api/cli/settings")}`, {
      headers,
    }, { phase: "plan-preflight (settings)", timeoutMs: SETTINGS_PREFLIGHT_TIMEOUT_MS });
  } catch {
    // Fail open: keep cached settings, back off until the next window.
    remember(sentHash, now);
    return;
  }
  // Unchanged: the server answered 304 with an empty body — one tiny
  // request, nothing else happens (no merge, no settings write).
  if (res.status === 304) {
    remember(sentHash, now);
    return;
  }
  if (!res.ok) {
    remember(sentHash, now);
    return;
  }
  const data = (await res.json()) as {
    settings?: ProtoSettings;
    settingsHash?: unknown;
  };
  const nextHash = typeof data.settingsHash === "string" ? data.settingsHash : null;
  if (data.settings && Object.keys(data.settings).length > 0) {
    if (projectDir !== undefined) {
      const latest = readSettingsParts(projectDir);
      if (fingerprintSettings(latest.global, latest.project) !== fingerprint) {
        // A settings edit landed while the request was in flight: do NOT
        // overwrite the newer state and do NOT stamp it fresh — stay
        // eligible so the next invocation reconciles.
        return;
      }
    }
    writeGlobalSettings({ ...data.settings });
  }
  remember(nextHash, now);
}

/**
 * Parse one boards-list page into workspace picks.
 *
 * Decision record (ticket 3ac40717, worker 2026-10-17):
 * - WHAT: accept the v0 envelope `{ items: [{ id, name, ... }], nextCursor }`
 *   (the documented `list-boards` shape) with a legacy `{ workspaces }`
 *   fallback, instead of reading only `{ workspaces }`.
 * - WHY: `surfacePath("cloud", "/api/cli/workspaces")` maps to
 *   `/api/v0/boards`, which answers `{ items }` — never `{ workspaces }` —
 *   so the old parse always saw "no boards" even when the account HAS
 *   boards, and every fresh device login dead-ended at "No boards found".
 * - IMPACT: the row carries no `url`/`icon` (v0 boards answer
 *   `id/name/slug/role`), so `url` falls back to the app base the token
 *   belongs to and `icon` to null; legacy rows keep their own fields.
 */
function toWorkspacePick(
  row: Record<string, unknown>,
  apiUrl: string,
): WorkspaceInfo | null {
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  return {
    id: row.id,
    name: typeof row.name === "string" && row.name.length > 0 ? row.name : "Untitled board",
    icon: typeof row.icon === "string" ? row.icon : null,
    url: typeof row.url === "string" && row.url.length > 0 ? row.url : apiUrl,
  };
}

function parseBoardsPage(
  data: unknown,
  apiUrl: string,
): { picks: WorkspaceInfo[]; nextCursor: string | null } {
  const body = (data ?? {}) as {
    items?: unknown;
    workspaces?: unknown;
    nextCursor?: unknown;
  };
  const rows = Array.isArray(body.items)
    ? body.items
    : Array.isArray(body.workspaces)
      ? body.workspaces
      : [];
  const picks: WorkspaceInfo[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const pick = toWorkspacePick(row as Record<string, unknown>, apiUrl);
    if (pick) picks.push(pick);
  }
  return {
    picks,
    nextCursor:
      typeof body.nextCursor === "string" && body.nextCursor.length > 0
        ? body.nextCursor
        : null,
  };
}

async function fetchAndSelectWorkspace(
  apiUrl: string,
  token: string,
): Promise<WorkspaceInfo | null> {
  try {
    const headers = { Authorization: `Bearer ${token}` };
    // Cloud-only paths: apiUrl is the getApiUrl() SaaS base → always "cloud".
    const profileRes = await fetch(
      `${apiUrl}${surfacePath("cloud", "/api/cli/profile")}`,
      { headers },
    );
    const boardsPath = surfacePath("cloud", "/api/cli/workspaces");
    const picks: WorkspaceInfo[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const url = new URL(`${apiUrl}${boardsPath}`);
      if (cursor) url.searchParams.set("cursor", cursor);
      const wsRes = await fetch(url.toString(), { headers });
      if (!wsRes.ok) {
        // NEVER swallow: returning quietly here left the account with no board
        // selected while login still printed "Logged in successfully", and the
        // next push died with a bare "HTTP 422". Measured on a 2-board account.
        console.log(
          chalk.yellow(
            `  Could not list boards (HTTP ${wsRes.status}) — no board selected. Run \`vibeflow auth login\` again, or \`vibeflow push --workspace <boardId>\`.`,
          ),
        );
        return null;
      }
      const page_ = parseBoardsPage(await wsRes.json(), apiUrl);
      picks.push(...page_.picks);
      cursor = page_.nextCursor;
      if (!cursor) break;
    }
    if (picks.length === 0) {
      console.log(chalk.yellow("  No boards found on this account yet."));
      console.log(
        chalk.dim(
          `  Create one in the web app (${apiUrl}), then run \`vibeflow auth login\` again to pick it.`,
        ),
      );
      return null;
    }

    const profile = profileRes.ok
      ? ((await profileRes.json()) as { email?: string })
      : null;
    const selected = await promptWorkspaceSelection(picks);
    // Project-scoped (ADR-0005): the caller persists the board as the
    // project's pointer plus the account credential — nothing global.
    const withAccount = { ...selected, email: profile?.email ?? null };
    console.log(
      chalk.green(`  Board set: ${selected.icon ?? ""} ${selected.name}`),
    );
    console.log(chalk.dim(`  Open at: ${selected.url}`));
    return withAccount;
  } catch (err) {
    // Non-critical — but silence is what made this a mystery: the user was
    // never asked to pick a board and only saw a 422 much later. Name the
    // failure and the way out (ticket: 2-board account, device login).
    console.log(
      chalk.yellow(
        `  Board selection failed (${err instanceof Error ? err.message : String(err)}) — no board selected.`,
      ),
    );
    console.log(
      chalk.dim("  Run `vibeflow auth login` again in an interactive terminal, or use `vibeflow push --workspace <boardId>`."),
    );
    return null;
  }
}

/**
 * Cloud batch-import replacement: the v0 contract offers no batch import op,
 * so each unsynced local task is created with one `POST /api/v0/tasks` call
 * (`surfacePath("cloud", "/api/cli/tasks")`). A non-ok response counts the
 * task as skipped (same message shape the single-call import produced).
 * Mode is always `"cloud"`: callers address the `getApiUrl()` SaaS base.
 *
 * `boardId` is optional: callers that push without a selected board omit it
 * and the cloud files the task under the default board (the legacy batch
 * import likewise carried no board when none was selected). `idMap` maps
 * each created task's local id to its cloud id (parsed from the bare v0
 * task body) so
 * callers can follow up with per-task file uploads.
 *
 * Push is TWO-PHASE so links survive the local-id → cloud-id namespace
 * hop. Phase 1 (`createTasksOneByOne` below) creates every task WITHOUT
 * `links`: a local parent link names a LOCAL id the cloud has never seen,
 * so v0's parent-target validation answers 400 and the whole task counts
 * as skipped (a fresh 3-task push with one parent/child pair reported
 * `Pushed 2 … Skipped 1`), and create-order cannot fix it in general — a
 * child pushed before its parent has an unknown target id. Phase 2
 * (`applyPushLinks`) then replays each stored link with the target
 * translated from the local id to the created cloud id from `idMap`, via
 * `POST /api/v0/tasks/{id}/links` (`{ taskId, type }` — the contract's
 * `add-link` op; see its doc comment for the shape choice). Links whose
 * target is not in the push set and unknown in-board are skipped and
 * REPORTED, never fatal to the push.
 */
/**
 * Build the `POST /api/v0/tasks` body for one local task record: the
 * record itself minus `links`, plus `boardId` when selected. Phase 1 of
 * the two-phase push (see `createTasksOneByOne`): `links` is the one key
 * v0 validates against server state (parent targets must already exist
 * in-board), so it travels in phase 2 via `applyPushLinks` with resolved
 * cloud ids — never inline. Everything else unknown (`filePath`,
 * timestamps, `files[]` refs, …) the POST ignores, and the `files[]` refs
 * deliberately ride along (system-flag round-trip pin in `push.test.ts`).
 * `undefined` values are omitted so absent stays absent.
 */
export function toV0CreateBody(
  task: Record<string, unknown>,
  boardId: string | undefined,
): Record<string, unknown> {
  const { links: _dropped, ...rest } = task;
  void _dropped;
  const body: Record<string, unknown> = { ...rest };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  if (boardId !== undefined) body.boardId = boardId;
  else delete body.boardId;
  return body;
}

/**
 * Bulk-push progress display (ticket 7db36f78).
 * WHAT: a ~20-line renderer shared by BOTH bulk-push paths — the
 * login-time push (`promptPushLocalTasks` below) and the standalone
 * `push` command (`src/commands/push.ts`) — because both push through
 * the same `createTasksOneByOne()` loop, so one `onProgress` hook covers
 * both with no duplicated rendering code.
 * WHY: pushing 1704 unsynced tasks ran with no indication of progress
 * (the pre-push listing shows 10 titles + "… and N more", then silence
 * until done). The counter (`Pushing done/total`) is always emitted so a
 * greppable exact `pushed/total` pair exists in every mode; the visual
 * bar only renders on a TTY where `\r` rewrites work, otherwise each
 * update is its own counter-only line. Everything goes to STDERR — never
 * stdout — so piped output and `--json` stay clean.
 */
/**
 * Minimal push ETA (ticket e4049164).
 * WHAT: `done`-over-elapsed rate from the push start time; the caller
 * passes the reporter's start timestamp, never a global.
 * WHY arithmetic-only (no new deps): a bulk push is one POST per task at
 * a roughly steady rate, so remaining/rate is an honest estimate.
 * `--:--` until measurable (zero/negative elapsed, nothing done yet, or a
 * non-positive total) and `0s` at completion — never NaN/negative/garbage
 * on tiny pushes where elapsed rounds to 0ms.
 */
export function formatPushEta(
  startMs: number,
  done: number,
  total: number,
  nowMs: number = Date.now(),
): string {
  const elapsedMs = nowMs - startMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || done <= 0 || total <= 0)
    return "--:--";
  if (done >= total) return "0s";
  const rate = done / (elapsedMs / 1000);
  if (!Number.isFinite(rate) || rate <= 0) return "--:--";
  const etaSec = Math.ceil((total - done) / rate);
  if (!Number.isFinite(etaSec) || etaSec < 0) return "--:--";
  if (etaSec < 60) return `${etaSec}s`;
  return `${Math.floor(etaSec / 60)}m${String(etaSec % 60).padStart(2, "0")}s`;
}

export function formatTaskPushProgress(
  done: number,
  total: number,
  startMs?: number,
  nowMs?: number,
): string {
  const counter = `Pushing ${done}/${total}`;
  if (process.stdout.isTTY !== true) return counter;
  const width = 20;
  const filled =
    total <= 0 ? width : Math.round((Math.min(done, total) / total) * width);
  const pct = total <= 0 ? 100 : Math.round((Math.min(done, total) / total) * 100);
  // ETA (ticket e4049164): appended to the single TTY line; without a
  // start timestamp elapsed is 0 by construction, so it reads `--:--`.
  const now = nowMs ?? Date.now();
  const eta = formatPushEta(startMs ?? now, done, total, now);
  return `${counter} [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${pct}% ETA ${eta}`;
}

/**
 * Minimal push reporter (ticket e4049164).
 * WHAT: a per-push factory — the caller builds one reporter per push run
 * and passes it as the `createTasksOneByOne()` `onProgress` hook — so a
 * TTY stays ONE `\r`-rewritten line (counter + bar + pct + ETA) and piped
 * output stays sparse.
 * SPARSE RULE (piped/non-TTY only, recorded here): emit at most one line
 * per 10% of total (the `floor(done/total*10)` bucket must advance past
 * the last emitted one), or one line per 10s on slow pushes, plus ALWAYS
 * the final `done >= total` line so scripts can grep the exact `N/N`.
 * WHY a factory and not globals: two pushes in one process (tests, login
 * then push) must not share start-time/bucket state.
 * WHY throttling still applies under --verbose: per-task progress is not
 * diagnostic detail — the FULL refusal/link detail already lives behind
 * --verbose/--json (dec52322), and the --json envelope carries
 * attempted/total; progress stays minimal in every mode.
 */
const PUSH_PROGRESS_BUCKETS = 10;
const PUSH_PROGRESS_MIN_INTERVAL_MS = 10_000;

export function createTaskPushProgressReporter(
  total: number,
  opts?: { startMs?: number; now?: () => number },
): (done: number, total: number) => void {
  const startMs = opts?.startMs ?? Date.now();
  const now = opts?.now ?? Date.now;
  let lastBucket = -1;
  let lastEmitMs = Number.NEGATIVE_INFINITY;
  void total;
  return (done: number, runTotal: number) => {
    const at = now();
    const line = formatTaskPushProgress(done, runTotal, startMs, at);
    if (process.stdout.isTTY === true) {
      process.stderr.write(`\r  ${line}`);
      if (done >= runTotal) process.stderr.write("\n");
      return;
    }
    const denom = runTotal <= 0 ? 1 : runTotal;
    const bucket = Math.floor(
      (Math.min(done, runTotal) / denom) * PUSH_PROGRESS_BUCKETS,
    );
    if (
      done >= runTotal ||
      bucket > lastBucket ||
      at - lastEmitMs >= PUSH_PROGRESS_MIN_INTERVAL_MS
    ) {
      lastBucket = Math.max(lastBucket, bucket);
      lastEmitMs = at;
      process.stderr.write(`  ${line}\n`);
    }
  };
}

export function reportTaskPushProgress(done: number, total: number): void {
  const line = formatTaskPushProgress(done, total);
  if (process.stdout.isTTY === true) {
    process.stderr.write(`\r  ${line}`);
    if (done >= total) process.stderr.write("\n");
  } else {
    process.stderr.write(`  ${line}\n`);
  }
}

/**
 * Push honesty (ticket dec52322).
 * WHAT: the per-task refusal record for the shared `createTasksOneByOne()`
 * loop, plus the loop's grouped result and the summary/link formatters.
 * WHY: POST /api/v0/tasks has NO duplicate detection — "already existed"
 * NEVER happens — yet every non-ok used to count as a generic `skipped`
 * with res.status swallowed, so a 1704-task push that the server refused
 * (402 TASK_LIMIT / 429 token-bucket) reported "1644 already existed".
 * The loop now records status + server error code per refusal, groups
 * identical refusals for a TRUE summary line (e.g. "60 created, 1319
 * refused: 402 plan-limit ×1319"), and stops early on 402/429 where
 * further POSTs are futile. Network throws still propagate (callers
 * report them as a failed push) — only HTTP non-ok counts as refused.
 */
export interface PushRefusalGroup {
  /** HTTP status the server answered (e.g. 400, 402, 429). */
  status: number;
  /** Server error code/message (`code` ?? `error` ?? `message`, else `HTTP <status>`). */
  code: string;
  /** How many tasks were refused with exactly this status + code. */
  count: number;
}

export interface PushLoopResult {
  imported: number;
  /** Re-push matches (ticket 9309ea70): items the server resolved to
   * already-existing rows. They fill the idMap (links heal) but are
   * never counted as imported and never print as created. */
  existing: number;
  skipped: number;
  idMap: Record<string, string>;
  /** POSTs actually attempted (differs from tasks.length after early stop). */
  attempted: number;
  /** Refusals grouped by status + server code, in first-seen order. */
  failures: PushRefusalGroup[];
  /** Non-null when the loop stopped before attempting every task. */
  stoppedEarly: "plan-limit" | "rate-limited" | null;
  /** The server's message on the refusal that stopped the loop. */
  stopMessage: string | null;
  /** `retry-after` response header on the 429 that stopped the loop. */
  retryAfter: string | null;
}

/** Extract the grouping code from a refusal body: `code` ?? `error` ??
 * `message` (trimmed, capped), else `HTTP <status>` so a bodyless refusal
 * still groups by status instead of vanishing. */
export function pushRefusalCode(status: number, body: unknown): string {
  const record =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  for (const key of ["code", "error", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().slice(0, 120);
    }
  }
  return `HTTP ${status}`;
}

/** TRUE push summary line from grouped refusals — e.g. "60 created, 5
 * refused: 402 plan limit ×3, 400 validation ×2". Re-push matches
 * (ticket 9309ea70) print as "already existed", never as created:
 * the batch endpoint dedups by stored cliId. */
export function formatPushRefusalSummary(result: {
  imported: number;
  skipped: number;
  failures: PushRefusalGroup[];
  existing?: number;
}): string {
  const already = result.existing ?? 0;
  const created =
    already > 0
      ? `${result.imported} created, ${already} already existed`
      : `${result.imported} created`;
  if (result.skipped === 0) return `${created}, 0 refused`;
  const groups = result.failures.map(
    (g) => `${g.status} ${g.code} ×${g.count}`,
  );
  const detail = groups.length > 0 ? groups.join(", ") : `${result.skipped} refused`;
  return `${created}, ${result.skipped} refused: ${detail}`;
}

/** Loud early-stop line for 402/429: the server's message plus what it
 * means (further POSTs futile) and, for 429, the retry-after. Printed
 * by both push surfaces on stderr-adjacent console output. */
export function formatPushStopLine(result: {
  stoppedEarly: PushLoopResult["stoppedEarly"];
  stopMessage: string | null;
  retryAfter: string | null;
}): string | null {
  if (result.stoppedEarly === "plan-limit") {
    return (
      `Server refused with 402 (plan/task limit): ${result.stopMessage ?? "no message"}. ` +
      `Stopping — further POSTs would also fail.`
    );
  }
  if (result.stoppedEarly === "rate-limited") {
    const when =
      result.retryAfter !== null && result.retryAfter.length > 0
        ? result.retryAfter
        : "unknown";
    return (
      `Rate limited (429; retry after ${when}): ${result.stopMessage ?? "no message"}. ` +
      `Stopping — further POSTs would also fail.`
    );
  }
  return null;
}

/** Skipped-link summary grouped by link type with the first few examples;
 * the FULL from→to list only travels when `verbose` (the `--verbose` /
 * `--json` gate: a 1704-task push can skip hundreds of links and the
 * default line must stay readable). */
export function formatSkippedLinks(
  skipped: SkippedPushLink[],
  verbose: boolean,
): string {
  const byType = new Map<string, number>();
  for (const link of skipped) {
    byType.set(link.type, (byType.get(link.type) ?? 0) + 1);
  }
  const groups = [...byType.entries()].map(([type, n]) => `${type} ×${n}`);
  const shown = verbose ? skipped : skipped.slice(0, 5);
  const examples = shown.map((l) => `${l.from}→${l.to} (${l.type})`).join(", ");
  const hidden =
    !verbose && skipped.length > shown.length
      ? ` … and ${skipped.length - shown.length} more (re-run with --verbose for the full list)`
      : "";
  return `Skipped ${skipped.length} link${skipped.length !== 1 ? "s" : ""} (${groups.join(", ")}): ${examples}${hidden}`;
}

/**
 * Bounded 429 wait-resume (ticket 99cf6943).
 * WHAT: both push loops (the one-by-one loop below, and the batch loop
 * in `saas/batch-push.ts`) sleep `min(Retry-After, 120s)` on a 429 then
 * CONTINUE from the same position instead of stopping; at most 3 waits
 * per push, then stop loudly as before. Preflight refusal stays
 * refuse-only (no prompt, no wait).
 * WHY these numbers: throttled plans allow ~12 writes/min, so a bulk push
 * always trips the token bucket and stopping on the first 429 abandoned
 * ~1670 tasks. 3 resumes x up to 120s bounds the worst stall at 6 min;
 * the 120s cap bounds a single wait against a bogus header (Retry-After:
 * 3600 would otherwise park the push for an hour), and the 60s default
 * covers a missing/unparseable header (about one bucket window).
 * Owner-approved scope (ticket 99cf6943) — do not raise without re-check.
 */
export const PUSH_429_MAX_WAIT_MS = 120_000;
export const PUSH_429_DEFAULT_WAIT_MS = 60_000;
export const PUSH_429_MAX_RESUMES = 3;

/** Parse a Retry-After header to a bounded wait (ticket 99cf6943): numeric
 * seconds or an HTTP-date delta; missing/unparseable/negative hold the
 * 60s default; everything caps at PUSH_429_MAX_WAIT_MS. Pure. */
export function resolve429WaitMs(
  retryAfter: string | null,
  nowMs: number = Date.now(),
): number {
  if (retryAfter !== null) {
    const raw = retryAfter.trim();
    // Integer seconds (the normal server form). Negative or fractional
    // numerics are meaningless here — default, never a 0ms hot loop.
    // (A bare "-5" must NOT reach Date.parse: V8 reads it as a date
    // near now and the wait collapses to ~0.)
    if (raw !== "") {
      const secs = Number(raw);
      if (Number.isInteger(secs)) {
        return secs >= 0
          ? Math.min(secs * 1000, PUSH_429_MAX_WAIT_MS)
          : PUSH_429_DEFAULT_WAIT_MS;
      }
    }
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) {
      return Math.min(Math.max(at - nowMs, 0), PUSH_429_MAX_WAIT_MS);
    }
  }
  return PUSH_429_DEFAULT_WAIT_MS;
}

/** 429 wait-resume knobs shared by both push loops (ticket 99cf6943). */
export interface Push429ResumeOptions {
  /** Max wait-resumes per push (default PUSH_429_MAX_RESUMES); 0 restores
   * the pre-99cf6943 stop-on-first-429 behavior (tests pin it). */
  maxResumes?: number;
  /** Sleep impl (default real sleep); tests inject a spy. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Called BEFORE each wait with (waitMs, resumeNumber 1-based). */
  onWait?: (waitMs: number, resume: number) => void;
}

export async function createTasksOneByOne(
  apiUrl: string,
  token: string,
  boardId: string | undefined,
  tasks: Array<Record<string, unknown>>,
  onProgress?: (done: number, total: number) => void,
  retry429?: Push429ResumeOptions,
): Promise<PushLoopResult> {
  let imported = 0;
  let skipped = 0;
  let attempted = 0;
  const idMap: Record<string, string> = {};
  const groupOrder: string[] = [];
  const groups = new Map<string, PushRefusalGroup>();
  let stoppedEarly: PushLoopResult["stoppedEarly"] = null;
  let stopMessage: string | null = null;
  let retryAfter: string | null = null;
  // 429 wait-resume budget (ticket 99cf6943): every 429 wait in this push
  // — same-task retries here, chunk re-POSTs and mid-chunk pauses in the
  // batch loop — spends from one per-push allowance of 3.
  const maxResumes = retry429?.maxResumes ?? PUSH_429_MAX_RESUMES;
  const sleep429 = retry429?.sleepMs ?? sleep;
  let resumes = 0;
  const recordRefusal = (status: number, code: string): void => {
    const key = `${status} ${code}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else {
      groups.set(key, { status, code, count: 1 });
      groupOrder.push(key);
    }
    skipped++;
  };
  const createPath = surfacePath("cloud", "/api/cli/tasks");
  let index = 0;
  while (index < tasks.length) {
    const task = tasks[index]!;
    const localId = task.id;
    // A network throw still fails the push outright (callers report it as
    // a failed push); only HTTP non-ok responses count as per-task skips.
    const res = await fetch(`${apiUrl}${createPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        // The resolved board scopes this create (ticket 605e503c) — every
        // caller passes the board explicitly, so the saved-workspace peek
        // (empty in `--board` flows without a prior login) must not be used.
        ...scopeHeaderFor(boardId),
      },
      body: JSON.stringify(toV0CreateBody(task, boardId)),
      // Bound fetch (ticket dec52322): a hung create must not stall a
      // 1704-task push forever — 30s then throw like a network error.
      signal: AbortSignal.timeout(30_000),
    });
    attempted++;
    if (!res.ok) {
      const status = res.status;
      let errorBody: unknown = null;
      try {
        errorBody = await res.json();
      } catch {
        errorBody = null;
      }
      const code = pushRefusalCode(status, errorBody);
      // Early stop (ticket dec52322): after a 402 every further POST is
      // futile (plan/task limit — creating more cannot succeed). After a
      // 429 the loop now waits and retries instead (ticket 99cf6943):
      // the 429 refused THIS task, so with budget left nothing is
      // recorded — sleep min(Retry-After, 120s), then re-POST the same
      // task. Budget exhausted → record and stop loudly, as before.
      if (status === 402) {
        recordRefusal(status, code);
        // A refused task is still a finished unit of the push: the
        // counter tracks attempted/total so a refusal still reads k/N.
        onProgress?.(imported + skipped, tasks.length);
        stoppedEarly = "plan-limit";
        stopMessage = code;
        break;
      }
      if (status === 429) {
        let header: string | null = null;
        try {
          header = res.headers?.get?.("retry-after") ?? null;
        } catch {
          header = null;
        }
        if (resumes < maxResumes) {
          resumes++;
          const waitMs = resolve429WaitMs(header);
          retry429?.onWait?.(waitMs, resumes);
          await sleep429(waitMs);
          continue;
        }
        recordRefusal(status, code);
        stoppedEarly = "rate-limited";
        stopMessage = code;
        retryAfter = header;
        // The stopping refusal is attempted work too — report k/N like
        // every other refusal above.
        onProgress?.(imported + skipped, tasks.length);
        break;
      }
      recordRefusal(status, code);
      // A refused task is still a finished unit of the push: the counter
      // tracks attempted/total so a mid-push refusal still reads k/N.
      onProgress?.(imported + skipped, tasks.length);
      index++;
      continue;
    }
    imported++;
    onProgress?.(imported + skipped, tasks.length);
    if (typeof localId === "string" && localId.length > 0) {
      // v0 answers the bare created task (contract Task).
      const body = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const created = (body ?? {}) as Record<string, unknown>;
      const remoteId =
        typeof created.id === "string" && created.id.length > 0
          ? created.id
          : localId;
      idMap[localId] = remoteId;
    }
    index++;
  }
  return {
    imported,
    // One-by-one single-creates never dedup (no cliId matching on that
    // path) — existing stays 0, honest by construction.
    existing: 0,
    skipped,
    idMap,
    attempted,
    failures: groupOrder.map((k) => groups.get(k)!),
    stoppedEarly,
    stopMessage,
    retryAfter,
  };
}

/** Link types the v0 link surface accepts. */
const PUSH_LINK_TYPES = new Set(["parent", "relates", "blocks"]);

export interface SkippedPushLink {
  /** Local id of the task carrying the link. */
  from: string;
  /** Stored (local) id of the link target. */
  to: string;
  type: string;
  reason: string;
}

export interface ApplyPushLinksResult {
  applied: number;
  skipped: SkippedPushLink[];
}

/**
 * Phase 2 of the two-phase push: replay every stored `links` entry with
 * the target translated from the local id to the created cloud id.
 *
 * Mechanism is `POST /api/v0/tasks/{id}/links` with `{ taskId, type }`
 * — the v0 contract's `add-link` op (`docs/api/v0-contract.json`, new
 * endpoint shape for links which no longer ride on create/update). The
 * `{ taskId, type }` key spelling matches the live cloud parser (the v0
 * tasks route validates `body.links[]` as `{ taskId, type }` and the
 * links route reads `body.taskId`); the public openapi draft spells the
 * target key `target`, but the cloud this path talks to reads `taskId`,
 * so `taskId` is what travels. A follow-up create/PATCH carrying
 * resolved `links` was rejected: PATCH replaces task state wholesale and
 * risks clobbering, while the links endpoint is additive and idempotent
 * (an already-present pair answers 200 `duplicate: true`).
 *
 * Runs strictly AFTER `createTasksOneByOne`, so every pushed target
 * already exists in-board and parent validation passes regardless of
 * create order. A link whose target is NOT in `idMap` (not part of this
 * push — or its create was skipped) is skipped and reported, never
 * fatal: a single unknown target must not fail the whole push. Per-link
 * HTTP/network failures degrade to skipped entries for the same reason.
 * Mode is always `"cloud"`: callers address the `getApiUrl()` SaaS base.
 */
/**
 * Ticket 57aff0df: resolve a local id against the board when the current
 * run's idMap has no entry. The task may exist remotely from an EARLIER
 * push (locals since deleted, or a later task linking back) — the
 * single-task GET resolves by cliId OR id, so one read heals the link.
 * Non-OK (404 unknown, 409 ambiguous, network throw) means truly
 * unresolvable → undefined, and the caller keeps its clean skip. Only
 * fires for idMap misses, so the common path costs nothing extra.
 * Resolved ids are written back into the caller's idMap (same object
 * the file phase reads), so healed tasks upload their files too.
 */
async function resolveRemoteTaskId(
  apiUrl: string,
  token: string,
  localId: string,
  boardId: string | undefined,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${apiUrl}${surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(localId)}`)}`,
      { headers: { Authorization: `Bearer ${token}`, ...scopeHeaderFor(boardId) } },
    );
    if (!res.ok) return undefined;
    const body = (await res.json().catch(() => null)) as {
      id?: unknown;
    } | null;
    return typeof body?.id === "string" && body.id.length > 0
      ? body.id
      : undefined;
  } catch {
    return undefined;
  }
}

export async function applyPushLinks(
  apiUrl: string,
  token: string,
  tasks: Array<Record<string, unknown>>,
  idMap: Record<string, string>,
  boardId?: string,
): Promise<ApplyPushLinksResult> {
  let applied = 0;
  const skipped: SkippedPushLink[] = [];
  // Ticket 57aff0df: miss cache — a target (or source) resolved once via
  // the fallback lookup is reused for the rest of this run, so N links
  // to the same earlier-pushed task cost one GET, not N.
  const healed = new Map<string, string>();
  const healedRemoteId = async (localId: string): Promise<string | undefined> => {
    const cached = healed.get(localId);
    if (cached !== undefined) return cached;
    const resolved = await resolveRemoteTaskId(apiUrl, token, localId, boardId);
    if (resolved !== undefined) {
      healed.set(localId, resolved);
      // Write-back: the file phase reads this same idMap object after
      // links, so healed tasks upload their attachments too.
      idMap[localId] = resolved;
    }
    return resolved;
  };
  for (const task of tasks) {
    const localId = task.id;
    if (typeof localId !== "string" || localId.length === 0) continue;
    const links = task.links;
    if (!Array.isArray(links) || links.length === 0) continue;
    for (const link of links) {
      const target =
        typeof link === "object" && link !== null
          ? (link as Record<string, unknown>).taskId
          : undefined;
      const type =
        typeof link === "object" && link !== null
          ? (link as Record<string, unknown>).type
          : undefined;
      if (
        typeof target !== "string" ||
        target.length === 0 ||
        typeof type !== "string" ||
        !PUSH_LINK_TYPES.has(type)
      ) {
        skipped.push({
          from: localId,
          to: typeof target === "string" ? target : "",
          type: typeof type === "string" ? type : "",
          reason: "malformed link entry",
        });
        continue;
      }
      // Ticket 57aff0df: the source may exist remotely from an earlier
      // push (deduped re-push, or locals deleted between runs) — resolve
      // it by cliId before giving up.
      const remoteSource =
        idMap[localId] ?? (await healedRemoteId(localId));
      if (remoteSource === undefined) {
        skipped.push({
          from: localId,
          to: target,
          type,
          reason: "source task was not created",
        });
        continue;
      }
      // Ticket 57aff0df: same healing for the target side — a link to a
      // task pushed in an earlier run resolves via cliId lookup instead
      // of skipping forever.
      const remoteTarget =
        idMap[target] ?? (await healedRemoteId(target));
      if (remoteTarget === undefined) {
        skipped.push({
          from: localId,
          to: target,
          type,
          reason: "link target is not part of this push",
        });
        continue;
      }
      try {
        // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always
        // "cloud", so the legacy `/api/cli/tasks/:id/links` form maps to
        // the v0 `add-link` op (`/api/v0/tasks/:id/links`).
        const res = await fetch(
          `${apiUrl}${surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(remoteSource)}/links`)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              ...scopeHeaderFor(boardId),
            },
            body: JSON.stringify({ taskId: remoteTarget, type }),
          },
        );
        if (res.ok) {
          applied++;
        } else {
          skipped.push({
            from: localId,
            to: target,
            type,
            reason: `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        skipped.push({
          from: localId,
          to: target,
          type,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { applied, skipped };
}

async function promptPushLocalTasks(
  projectDir: string,
  apiUrl: string,
  token: string,
  workspace: WorkspaceInfo,
): Promise<void> {
  const tasksDir = join(projectDir, PROTO_DIR, TASKS_DIR);
  if (!existsSync(tasksDir)) return;

  const taskFiles: string[] = [];
  try {
    for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const dayDir = join(tasksDir, entry.name);
        for (const f of readdirSync(dayDir).filter((f) =>
          f.endsWith(".json"),
        )) {
          taskFiles.push(join(dayDir, f));
        }
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        // Legacy flat layout — task JSON files directly under tasks/.
        taskFiles.push(join(tasksDir, entry.name));
      }
    }
  } catch {
    return;
  }

  if (taskFiles.length === 0) return;

  const localTasks = taskFiles.flatMap((f) => {
    try {
      return [
        JSON.parse(readFileSync(f, "utf-8")) as {
          id: string;
          title?: string;
          status?: string;
        },
      ];
    } catch {
      return [];
    }
  });

  // Fetch online task IDs to find which local tasks are not on the board.
  // Honesty (ticket dec52322): this listing is only the CLIENT-side diff —
  // the server may still refuse creates on push (402 plan limit, 429
  // quota, 400 validation), so the heading below must not promise they
  // WILL sync, and `listedOk` records whether the board even answered
  // (on failure every local task is attempted, said out loud).
  // Shared diff (diff-based push): the paginated online-id fetch lives in
  // `saas/batch-push.ts` (`fetchOnlineTaskIds`) — the standalone `push`
  // command calls the same helper, so the diff cannot drift between the
  // two paths. Lazy import: the import client imports this module, so a
  // static import would cycle.
  let onlineIds = new Set<string>();
  let listedOk = false;
  try {
    const batch = await import("../saas/batch-push.js");
    onlineIds = await batch.fetchOnlineTaskIds(apiUrl, token, workspace.id);
    listedOk = true;
  } catch {
    /* non-critical — treat all as unsynced, labelled below */
  }

  const unsynced = localTasks.filter((t) => !onlineIds.has(t.id));
  if (unsynced.length === 0) return;

  console.log();
  if (listedOk) {
    console.log(
      chalk.bold(
        `  ${unsynced.length} local task${unsynced.length !== 1 ? "s are" : " is"} not on the board:`,
      ),
    );
  } else {
    // The board listing failed: the diff above is unknown, so say so —
    // every local task will be attempted, and the push summary (true
    // grouped refusal counts) is the source of truth, not this list.
    console.log(
      chalk.bold(
        `  Could not read the board — attempting push of all ${localTasks.length} local task${localTasks.length !== 1 ? "s" : ""}:`,
      ),
    );
  }
  const preview = unsynced.slice(0, 10);
  for (const t of preview) {
    const status = t.status ? chalk.dim(` [${t.status}]`) : "";
    console.log(chalk.dim(`    • ${t.title ?? t.id}${status}`));
  }
  if (unsynced.length > 10) {
    console.log(chalk.dim(`    … and ${unsynced.length - 10} more`));
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      chalk.cyan("\n  Push them to your board now? [Y/n]: "),
      async (answer) => {
        rl.close();
        if (answer.trim().toLowerCase() === "n") {
          console.log(
            chalk.dim("  Skipped. You can push later with: vibeflow push"),
          );
          resolve();
          return;
        }

        const rl2 = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl2.question(
          chalk.cyan("  Delete local task files after push? [y/N]: "),
          async (answer2) => {
            rl2.close();
            const keepLocal = answer2.trim().toLowerCase() !== "y";
            void keepLocal;

            // Phase 1 is task creates (tree-import when the server offers
            // it, one POST per task otherwise), then links replayed with
            // resolved cloud ids + files uploaded (legacy phases, import
            // carries both). (keepLocalFiles previously rode
            // along to /api/cli/import; the v0 create op has no such field
            // and this flow never deleted client-side, so the answer is
            // kept for prompt parity only.)
            try {
              const { prepareTaskRecordsForPush } = await import("../core/tasks.js");
              // Re-read after the prompts: ids must be on disk before either
              // legacy creates or tree-import builds its payload (ae9e99fd).
              const wanted = new Set(unsynced.map((task) => task.id));
              // SAFETY: preflight returns validated task JSON snapshots plus
              // filePath; this cast adds an index signature without changing data.
              const records = prepareTaskRecordsForPush(projectDir)
                .filter((task) => wanted.has(task.id)) as unknown as Array<Record<string, unknown>>;
              // Minimal push progress (ticket e4049164): one \r line on a
              // TTY (counter + bar + pct + ETA), sparse lines when piped,
              // everything on stderr — the pre-push listing and the prompts
              // above stay byte-identical.
              const onProgress = createTaskPushProgressReporter(records.length);
              // 429 waits are user-visible stalls (ticket 99cf6943): say
              // how long and which resume — a silent 120s pause reads as
              // hung.
              const onWait = (waitMs: number, resume: number): void => {
                console.log(
                  chalk.yellow(
                    `  Rate limited — waiting ${Math.ceil(waitMs / 1000)}s before resuming (resume ${resume}/${PUSH_429_MAX_RESUMES})…`,
                  ),
                );
              };
              // Import-first (ticket bulk-429): the same probe → preflight
              // → chunked path as the standalone push. Old servers fall
              // back to the legacy phases below, byte-identical to before
              // (same args, same reporters — plus the 429 wait both paths
              // share). Preflight refusal stays refuse-only: print and stop
              // here, no prompt, no wait. A probe throw aborts loudly via
              // the catch below (same rule as the standalone push — a
              // server that cannot answer the probe gets no blind bulk).
              // Lazy import: the import client imports this module, so a
              // static import would cycle.
              const batch = await import("../saas/batch-push.js");
              // The board MUST travel with the probe (ticket dabd2fb7): a
              // 2-board account answers 422 SCOPE_REQUIRED without
              // X-Vibeflow-Scope, and this is called right after the user
              // picked a board above — so the id is known and omitting it made
              // a successful login end in "Push failed: ... none is selected".
              const probe = await batch.probeImportCapability(
                apiUrl,
                token,
                workspace.id,
              );
              // Tree-import tallies (import path only — legacy prints its
              // own phase lines below).
              let importLinksApplied = 0;
              let importLinksFailed = 0;
              let importFilesFailed = 0;
              let data: PushLoopResult;
              if (probe.supported === false) {
                data = await createTasksOneByOne(
                  apiUrl,
                  token,
                  workspace.id,
                  records,
                  onProgress,
                  { onWait },
                );
              } else {
                const { collectImportInputs } = await import("../commands/push.js");
                // SAFETY: `records` are the parsed task JSON objects read from
                // the store (listTasksWithPaths), so each entry is already a
                // plain record plus an optional string `id`. The cast is
                // representation-preserving — it only tells TypeScript the
                // index signature the parser guarantees at runtime.
                const inputs = batch.topoOrderImportTasks(
                  collectImportInputs(
                    projectDir,
                    records as unknown as Array<{ id?: string } & Record<string, unknown>>,
                  ),
                );
                const order = inputs.map((t) => t.localId);
                const existing = batch.readBatchCheckpoint(projectDir);
                const resumed =
                  existing !== null &&
                  existing.order.length === order.length &&
                  existing.order.every((id, i) => id === order[i])
                    ? existing.attempted
                    : 0;
                const refusal = batch.evaluateBatchPreflight(
                  inputs.length - resumed,
                  probe.preflight,
                );
                if (refusal !== null) {
                  console.error(chalk.red(`  ${refusal}`));
                  resolve();
                  return;
                }
                const loop = await batch.importBatchTree(
                  apiUrl,
                  token,
                  workspace.id,
                  inputs,
                  {
                    onProgress,
                    projectDir,
                    preflight: probe.preflight,
                    retry429: { onWait },
                  },
                );
                data = loop;
                importLinksApplied = loop.linksApplied;
                importLinksFailed = loop.linksFailed;
                importFilesFailed = loop.filesFailed;
                if (loop.linksApplied > 0)
                  console.log(
                    chalk.green(
                      `  ✓ Applied ${loop.linksApplied} link${loop.linksApplied !== 1 ? "s" : ""}`,
                    ),
                  );
                for (const l of loop.failedLinks) {
                  console.log(chalk.dim(`    link ${l.clientId}: ${l.reason}`));
                }
                if (loop.filesUploaded > 0)
                  console.log(
                    chalk.green(
                      `  ✓ Uploaded ${loop.filesUploaded} file(s) to storage`,
                    ),
                  );
                if (loop.filesSkippedPresent > 0)
                  console.log(
                    chalk.dim(`  Skipped ${loop.filesSkippedPresent} file(s) already present remotely.`),
                  );
                for (const f of loop.failedFiles) {
                  console.log(chalk.dim(`    - ${f.name}: ${f.reason}`));
                }
                // Per-task atomicity: skipped-whole tasks are retryable —
                // never silent, never marked pushed (a later `push` retries).
                for (const s of loop.skippedTasks) {
                  console.log(chalk.dim(`    task ${s.localId} skipped whole (retryable): ${s.reason}`));
                }
              }
              // Condensed summary (ticket e4049164): one line carries the
              // TRUE numbers (created/refused groups via
              // formatPushRefusalSummary), the stop line and the
              // not-attempted count share one red line. Re-push matches
              // (ticket 9309ea70) print as "already existed" so a
              // 0-created re-push does not read as a failure.
              const already =
                data.existing > 0 ? ` (${data.existing} already existed)` : "";
              const refused =
                data.skipped > 0 ? ` — ${formatPushRefusalSummary(data)}` : "";
              console.log(
                chalk.green(
                  `  ✓ Pushed ${data.imported} task${data.imported !== 1 ? "s" : ""} to ${workspace.name}${already}${refused}`,
                ),
              );
              const stopLine = formatPushStopLine(data);
              if (stopLine !== null) {
                const remaining = records.length - data.attempted;
                const unattempted =
                  remaining > 0
                    ? ` (${remaining} task${remaining !== 1 ? "s" : ""} not attempted.)`
                    : "";
                console.log(chalk.red(`  ${stopLine}${unattempted}`));
              }
              const links = probe.supported === false
                ? await applyPushLinks(apiUrl, token, records, data.idMap, workspace.id)
                : { applied: importLinksApplied, skipped: [] as Array<{ from: string; to: string; type: string; reason: string }> };
              if (probe.supported !== false && importLinksFailed > 0) {
                console.log(
                  chalk.yellow(
                    `  ⚠ ${importLinksFailed} link(s) failed to apply`,
                  ),
                );
              }
              if (links.applied > 0 && probe.supported === false)
                console.log(
                  chalk.green(
                    `  ✓ Applied ${links.applied} link${links.applied !== 1 ? "s" : ""}`,
                  ),
                );
              if (links.skipped.length > 0)
                console.log(
                  chalk.dim(`    (${formatSkippedLinks(links.skipped, false)})`),
                );
              // Legacy files phase (probe.supported === false ONLY): the
              // import path already carried every attachment (tally lines
              // printed above). Login never deletes local files
              // (keepLocal is prompt-parity only), so failures only warn
              // here — auth already succeeded and a later `vibeflow push`
              // retries the files. Lazy import: push.ts imports this
              // module, so a static import would cycle.
              if (probe.supported === false) {
                const taskMappings = records
                  .filter(
                    (t) =>
                      typeof t.id === "string" &&
                      (data.idMap[t.id] as string | undefined) !== undefined,
                  )
                  .map((t) => ({
                    localId: t.id as string,
                    remoteId: data.idMap[t.id as string] as string,
                  }));
                const { uploadPushedFiles } = await import("../commands/push.js");
                await uploadPushedFiles(
                  apiUrl,
                  token,
                  projectDir,
                  taskMappings,
                  workspace.id,
                );
              } else if (importFilesFailed > 0) {
                console.log(
                  chalk.yellow(
                    `  ⚠ ${importFilesFailed} file(s) failed to upload (they stay local for a later push)`,
                  ),
                );
              }
            } catch (err) {
              console.log(
                chalk.red(
                  `  Push failed: ${err instanceof Error ? err.message : "Network error"}`,
                ),
              );
            }
            resolve();
          },
        );
      },
    );
  });
}

/**
 * Device-poll response shapes (ticket 64204dec).
 *
 * The server answers FOUR shapes: `{ pending: true }`, `{ token }`
 * (authorized, code consumed), `{ expired: true }` (no row, or consumed
 * earlier), and `{ reused: true, tokenId, name }` (one token per machine,
 * 6e1aecea — a live token already exists for this user+machine, so the
 * server refuses to mint a second row and leaves the device row
 * UNCONSUMED so the client can retry).
 */
export type DevicePollOutcome =
  | { kind: "pending" }
  | { kind: "token"; token: string }
  | { kind: "expired" }
  | { kind: "reused"; tokenId: string; name: string };

/**
 * Ticket 64204dec: an unknown poll shape is a hard, named error — never
 * "pending". Treating `{ reused: true, ... }` as pending is what
 * converted an authorization success into a misleading
 * "Device code expired" on the very next poll.
 */
export class UnexpectedDevicePollResponseError extends Error {
  /** Machine-readable code: UNEXPECTED_DEVICE_POLL_RESPONSE. */
  readonly code = "UNEXPECTED_DEVICE_POLL_RESPONSE";
  /** Top-level keys the server actually sent (for the report). */
  readonly keys: string[];
  constructor(data: unknown) {
    const keys =
      typeof data === "object" && data !== null ? Object.keys(data) : [];
    super(
      `Unexpected device-poll response (keys: ${keys.length > 0 ? keys.join(", ") : "<none>"}). ` +
        `The login server answered a shape this CLI does not understand — refusing to treat it as pending.`,
    );
    this.name = "UnexpectedDevicePollResponseError";
    this.keys = keys;
  }
}

/**
 * Classify one device-poll body. Throws
 * UnexpectedDevicePollResponseError on anything outside the four-shape
 * contract — the caller fails loudly instead of polling forever. A
 * present-but-malformed field (non-string token, reuse without identity)
 * is unknown too: a half-shape must never be stored or adopted blindly.
 */
export function parseDevicePollResponse(data: unknown): DevicePollOutcome {
  if (typeof data === "object" && data !== null) {
    const body = data as Record<string, unknown>;
    if (body.pending === true) return { kind: "pending" };
    if (typeof body.token === "string" && body.token.length > 0)
      return { kind: "token", token: body.token };
    if (body.expired === true) return { kind: "expired" };
    if (
      body.reused === true &&
      typeof body.tokenId === "string" &&
      body.tokenId.length > 0 &&
      typeof body.name === "string"
    )
      return { kind: "reused", tokenId: body.tokenId, name: body.name };
  }
  throw new UnexpectedDevicePollResponseError(data);
}

/**
 * Shared post-token tail of every successful login (mint, rotate, adopt):
 * settings sync + board selection run concurrently, then the PAT lands in
 * the user-scoped store keyed by apiUrl and the selected board becomes
 * THIS project's pointer (ADR-0005). Nothing global is written.
 */
async function completeLoginWithToken(
  apiUrl: string,
  pat: string,
  resolvedDir: string,
  farewell: "minted" | "rotated" | "reused",
  reuseName?: string,
): Promise<void> {
  console.log();
  if (farewell === "reused") {
    console.log(
      chalk.green(
        `  Reusing your existing token${reuseName ? ` "${reuseName}"` : ""} — no new token minted.`,
      ),
    );
  }
  if (farewell === "rotated") {
    console.log(
      chalk.yellow(
        `  This machine already had a token${reuseName ? ` ("${reuseName}")` : ""} whose secret is gone — the old row was revoked and a fresh token was minted.`,
      ),
    );
  }
  console.log(
    chalk.green("  Logged in successfully. Now operating in online mode."),
  );
  const [selected] = await Promise.all([
    fetchAndSelectWorkspace(apiUrl, pat),
    fetchAndApplySettings(apiUrl, pat, resolvedDir),
  ]);
  // Project-scoped persistence (ADR-0005): the PAT lands in the
  // user-scoped store keyed by apiUrl; the selected board becomes
  // THIS project's pointer. Nothing global is written.
  await writeCredential(apiUrl, {
    token: pat,
    workspaceId: selected?.id,
    account: selected?.email ?? null,
  });
  if (selected) {
    writeProjectPointer(resolvedDir, { apiUrl, id: selected.id });
  }
  // After login, ask if user wants to push local tasks
  const pointer = readProjectPointer(resolvedDir);
  if (pointer) {
    await promptPushLocalTasks(resolvedDir, apiUrl, pat, {
      id: pointer.id,
      name: pointer.id,
      url: apiUrl,
      icon: null,
    });
  }
}

/**
 * Reuse branch (ticket 64204dec): the server answered
 * `{ reused: true, tokenId, name }` — a live token already exists for
 * this user+machine, and the device row is still unconsumed.
 *
 * - Live local credential for this apiUrl → adopt: prove the stored
 *   secret still authenticates (one profile read), then write/refresh
 *   the project pointer and say so. No second token is minted.
 * - No (or dead) local credential → rotate: ask the server for a fresh
 *   PAT (`{ deviceCode, rotate: true }`), letting it revoke the old row
 *   nobody can use anymore. The secret no longer exists anywhere, so
 *   "reuse" is useless to a client that never had it.
 */
async function handleReusePoll(
  apiUrl: string,
  deviceCode: string,
  resolvedDir: string,
  reused: { tokenId: string; name: string },
): Promise<"done" | "retry"> {
  let existing: { token: string; workspaceId?: string; account?: string | null } | null = null;
  try {
    existing = await readCredential(apiUrl);
  } catch {
    existing = null;
  }
  if (existing?.token) {
    // Adopt only what still authenticates: a revoked server-side secret
    // must fall through to rotate, never be adopted blindly.
    let alive = false;
    try {
      // Cloud-only path: apiUrl is the getApiUrl() SaaS base → "cloud".
      const probe = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/profile")}`, {
        headers: { Authorization: `Bearer ${existing.token}` },
      });
      alive = probe.ok;
    } catch {
      alive = false;
    }
    if (alive) {
      console.log();
      console.log(
        chalk.green(
          `  Reusing your existing token "${reused.name}" — no new token minted.`,
        ),
      );
      console.log(
        chalk.green("  Logged in successfully. Now operating in online mode."),
      );
      await fetchAndApplySettings(apiUrl, existing.token, resolvedDir);
      if (existing.workspaceId) {
        // The credential already names the linked board: adopt the link
        // directly, no re-prompt. Refresh the stored entry (account,
        // timestamp) while the secret stays untouched.
        await writeCredential(apiUrl, {
          token: existing.token,
          workspaceId: existing.workspaceId,
          account: existing.account ?? null,
        });
        writeProjectPointer(resolvedDir, { apiUrl, id: existing.workspaceId });
      } else {
        // No board bound yet (logged in when the account had none):
        // run the normal selection with the adopted token.
        const selected = await fetchAndSelectWorkspace(apiUrl, existing.token);
        await writeCredential(apiUrl, {
          token: existing.token,
          workspaceId: selected?.id,
          account: selected?.email ?? null,
        });
        if (selected) {
          writeProjectPointer(resolvedDir, { apiUrl, id: selected.id });
        }
      }
      return "done";
    }
    console.log(
      chalk.yellow("  The stored token no longer works — requesting a fresh one…"),
    );
  } else {
    console.log(
      chalk.dim(`  This machine already has a token ("${reused.name}") — requesting a fresh one…`),
    );
  }
  // Rotate: the server revokes the unusable old row, mints once, and
  // consumes the device row with the mint (exactly-once holds). The row
  // stays unconsumed on every other outcome, so a failed rotate is
  // retryable on the next plain poll.
  let rotateRes: Response | null = null;
  try {
    // Cloud-only path: apiUrl is the getApiUrl() SaaS base → "cloud".
    rotateRes = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/auth/device-poll")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode, rotate: true }),
    });
  } catch {
    console.error(
      chalk.red("  Rotate request failed (network error). Retrying…"),
    );
    return "retry";
  }
  if (!rotateRes.ok) {
    console.error(chalk.red("  Rotate request failed. Retrying…"));
    return "retry";
  }
  const outcome = parseDevicePollResponse(await rotateRes.json());
  if (outcome.kind === "token") {
    await completeLoginWithToken(apiUrl, outcome.token, resolvedDir, "rotated", reused.name);
    return "done";
  }
  if (outcome.kind === "expired") {
    console.error(chalk.red("  Device code expired. Please try again."));
    process.exitCode = ExitCode.AUTH;
    return "done";
  }
  // Pending (or a repeated reuse the server should never send to a
  // rotate): the device row survived — keep polling until the deadline.
  return "retry";
}

/**
 * Project-scoped login (ADR-0005): the device flow mints a credential
 * that is stored user-scoped (`credentials.json`, keyed by apiUrl) while
 * the selected board is written as the PROJECT's pointer
 * (`<project>/.vibeflow/settings.json` → `workspace: { apiUrl, id }`).
 * A resolvable project is required: outside one the command refuses
 * loudly and writes nothing anywhere.
 */
export async function login(projectDir?: string): Promise<void> {
  const dir = resolve(projectDir ?? ".");
  if (!existsSync(dir)) {
    console.error(chalk.red(`  Refusing: project not found: ${dir}.`));
    console.log(chalk.dim("  cd into a project or pass --project <dir>."));
    process.exitCode = ExitCode.AUTH;
    return;
  }
  const isStore = existsSync(join(dir, PROTO_DIR, "settings.json")) || existsSync(join(dir, PROTO_DIR, TASKS_DIR));
  const isRepo = existsSync(join(dir, ".git")) || existsSync(join(dir, ".vibeflow"));
  if (!isStore && !isRepo) {
    console.error(chalk.red(`  Refusing: ${dir} is not a project.`));
    console.log(chalk.dim("  cd into a project or pass --project <dir>."));
    console.log(chalk.dim('  To start a project here, run `vibeflow tasks --add --title "first task"` — that creates the .vibeflow/ store — or `git init`.'));
    process.exitCode = ExitCode.AUTH;
    return;
  }
  const resolvedDir = dir;
  const apiUrl = getApiUrl();
  console.log(chalk.cyan("  Initiating device login flow..."));

  let initRes: Response;
  try {
    // Step 1: Request device code
    // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
    initRes = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/auth/device-init")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceName: getDeviceName(),
        machineId: await getMachineId(),
      }),
    });
  } catch (err) {
    console.error(
      chalk.red(
        `  Failed to connect to login server: ${err instanceof Error ? err.message : "Network error"}`,
      ),
    );
    process.exitCode = ExitCode.AUTH;
    return;
  }

  if (!initRes.ok) {
    console.error(
      chalk.red(
        `  Failed to initiate login: ${initRes.status} ${initRes.statusText}`,
      ),
    );
    process.exitCode = ExitCode.AUTH;
    return;
  }

  const { deviceCode, verificationUrl, expiresIn } = (await initRes.json()) as {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresIn: number;
  };

  console.log();
  console.log(chalk.bold("  Open this URL in your browser to authorize:"));
  console.log(chalk.underline(`  ${verificationUrl}`));
  console.log();

  // Try to open the browser automatically.
  //
  // Skipped when `VIBEFLOW_NO_BROWSER=1`, or when the process has no TTY — an
  // unattended process (CI, a script, a test harness) has no business spawning
  // a browser. Without this, every `vibeflow login` in an automated run opened a
  // real tab on the developer's desktop, which is both disruptive and a way for
  // a test suite to leak into the user's session. The URL is printed either way,
  // so nothing is lost.
  const canOpenBrowser =
    process.env.VIBEFLOW_NO_BROWSER !== "1" && process.stdout.isTTY === true;
  if (canOpenBrowser) {
    try {
      await open(verificationUrl);
      console.log(chalk.dim("  (Browser opened automatically)"));
    } catch {
      // Not critical
    }
  }

  // Step 2: Poll for verification
  const deadline = Date.now() + expiresIn * 1000;
  const POLL_INTERVAL = 3000;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);

    let pollRes: Response | null = null;
    try {
      // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
      pollRes = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/auth/device-poll")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
    } catch {
      console.error(
        chalk.red("  Poll request failed (network error). Retrying..."),
      );
      continue;
    }

    if (!pollRes.ok) {
      console.error(chalk.red("  Poll request failed. Retrying..."));
      continue;
    }

    // Four-shape contract (ticket 64204dec): pending, token, expired,
    // and reused. Anything else is a hard named error — never "pending".
    // Treating an unknown shape as pending is what converted an
    // authorization success into a misleading "expired" on the next poll.
    let outcome: DevicePollOutcome;
    try {
      outcome = parseDevicePollResponse(await pollRes.json());
    } catch (err) {
      if (err instanceof UnexpectedDevicePollResponseError) {
        console.error(chalk.red(`  Login failed: ${err.message}`));
        console.error(chalk.dim(`  (code: ${err.code})`));
        process.exitCode = ExitCode.AUTH;
        return;
      }
      throw err;
    }

    if (outcome.kind === "token") {
      // The device flow issues an `api_tokens` PAT directly: the server
      // mints it on authorization and returns the plaintext exactly once
      // in `{ token }`. The PAT is stored verbatim and is the Bearer
      // credential for every cloud call below
      // (`/api/v0` via `surfacePath("cloud", …)`).
      await completeLoginWithToken(apiUrl, outcome.token, resolvedDir, "minted");
      return;
    }

    if (outcome.kind === "expired") {
      console.error(chalk.red("  Device code expired. Please try again."));
      process.exitCode = ExitCode.AUTH;
      return;
    }

    if (outcome.kind === "reused") {
      // One token per machine (6e1aecea): adopt the existing link or
      // rotate to a fresh PAT. The device row survived (unconsumed), so
      // "retry" just keeps polling until the deadline.
      if ((await handleReusePoll(apiUrl, deviceCode, resolvedDir, outcome)) === "done") {
        return;
      }
      continue;
    }

    // pending — keep polling
    process.stdout.write(chalk.dim("."));
  }

  console.error(chalk.red("\n  Login timed out. Please try again."));
  process.exitCode = ExitCode.AUTH;
}
