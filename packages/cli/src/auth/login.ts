import chalk from "chalk";
import open from "open";
import readline from "node:readline";
import select from "@inquirer/select";
import { writeToken, readToken } from "./token.js";
import { writeWorkspace, type WorkspaceInfo } from "./workspace.js";
import {
  writeGlobalSettings,
  readGlobalSettings,
  type ProtoSettings,
} from "../core/settings.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROTO_DIR, TASKS_DIR } from "../core/types.js";
import { ExitCode } from "../core/exit-codes.js";
import { getApiUrl, surfacePath } from "../core/api-url.js";

const SETTINGS_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
): Promise<void> {
  try {
    // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
    const res = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/settings")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { settings: ProtoSettings };
    if (data.settings && Object.keys(data.settings).length > 0) {
      writeGlobalSettings({
        ...data.settings,
        _settingsRefreshedAt: Date.now(),
      });
    }
  } catch {
    // Non-critical
  }
}

export async function maybeRefreshSettings(): Promise<void> {
  try {
    const token = await readToken();
    if (!token) return;
    const existing = readGlobalSettings();
    const lastRefresh = existing._settingsRefreshedAt ?? 0;
    if (Date.now() - lastRefresh < SETTINGS_REFRESH_INTERVAL_MS) return;
    const apiUrl = getApiUrl();
    // Fire-and-forget background refresh
    void fetchAndApplySettings(apiUrl, token);
  } catch {
    // Non-critical
  }
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
): Promise<void> {
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
      if (!wsRes.ok) return;
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
      return;
    }

    const profile = profileRes.ok
      ? ((await profileRes.json()) as { email?: string })
      : null;
    const selected = await promptWorkspaceSelection(picks);
    await writeWorkspace({ ...selected, email: profile?.email ?? null });
    console.log(
      chalk.green(`  Board set: ${selected.icon ?? ""} ${selected.name}`),
    );
    console.log(chalk.dim(`  Open at: ${selected.url}`));
  } catch {
    // Non-critical — user can still use push --workspace
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
 * refused: 402 plan limit ×3, 400 validation ×2". Never claims
 * duplicates: the v0 create op has no duplicate detection. */
export function formatPushRefusalSummary(result: {
  imported: number;
  skipped: number;
  failures: PushRefusalGroup[];
}): string {
  const created = `${result.imported} created`;
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

export async function createTasksOneByOne(
  apiUrl: string,
  token: string,
  boardId: string | undefined,
  tasks: Array<Record<string, unknown>>,
  onProgress?: (done: number, total: number) => void,
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
  const createPath = surfacePath("cloud", "/api/cli/tasks");
  for (const task of tasks) {
    const localId = task.id;
    // A network throw still fails the push outright (callers report it as
    // a failed push); only HTTP non-ok responses count as per-task skips.
    const res = await fetch(`${apiUrl}${createPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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
      const key = `${status} ${code}`;
      const existing = groups.get(key);
      if (existing) existing.count++;
      else {
        groups.set(key, { status, code, count: 1 });
        groupOrder.push(key);
      }
      skipped++;
      // A refused task is still a finished unit of the push: the counter
      // tracks attempted/total so a mid-push refusal still reads k/N.
      onProgress?.(imported + skipped, tasks.length);
      // Early stop (ticket dec52322): after a 402 every further POST is
      // futile (plan/task limit — creating more cannot succeed), and
      // after a 429 every further POST is futile (token-bucket quota —
      // hammering on only extends the ban). Record the server's message
      // and stop; callers print it loudly.
      if (status === 402) {
        stoppedEarly = "plan-limit";
        stopMessage = code;
        break;
      }
      if (status === 429) {
        stoppedEarly = "rate-limited";
        stopMessage = code;
        try {
          retryAfter =
            res.headers?.get?.("retry-after") ?? null;
        } catch {
          retryAfter = null;
        }
        break;
      }
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
  }
  return {
    imported,
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
export async function applyPushLinks(
  apiUrl: string,
  token: string,
  tasks: Array<Record<string, unknown>>,
  idMap: Record<string, string>,
): Promise<ApplyPushLinksResult> {
  let applied = 0;
  const skipped: SkippedPushLink[] = [];
  for (const task of tasks) {
    const localId = task.id;
    if (typeof localId !== "string" || localId.length === 0) continue;
    const remoteSource = idMap[localId];
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
      if (remoteSource === undefined) {
        skipped.push({
          from: localId,
          to: target,
          type,
          reason: "source task was not created",
        });
        continue;
      }
      const remoteTarget = idMap[target];
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
  let onlineIds = new Set<string>();
  let listedOk = false;
  try {
    // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
    const res = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/tasks")}?boardId=${workspace.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as {
        items?: Array<Record<string, unknown>>;
        // Legacy fallback: the deleted `/api/cli/tasks` surface answered
        // `{ tasks }`; its rows carried `id` + `cliId`.
        tasks?: Array<{ id: string; cliId?: string | null }>;
      };
      // v0 canonical shape carries BOTH `id` (external) and `externalId`
      // (§3.1: `cliId ?? cloudId`); collect every id-like key so a local
      // task matching ANY of them counts as already synced.
      const rows = Array.isArray(data.items)
        ? data.items
        : (Array.isArray(data.tasks) ? data.tasks : []);
      const ids: string[] = [];
      for (const t of rows) {
        for (const key of ["id", "externalId", "cloudId", "cliId"]) {
          const v = (t as Record<string, unknown>)[key];
          if (typeof v === "string" && v.length > 0) ids.push(v);
        }
      }
      onlineIds = new Set(ids);
      listedOk = true;
    }
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

            // No batch import exists in the v0 contract: one POST per task
            // (phase 1), then links replayed with resolved cloud ids
            // (phase 2). (keepLocalFiles previously rode along to
            // /api/cli/import; the v0 create op has no such field and this
            // flow never deleted client-side, so the answer is kept for
            // prompt parity only.)
            try {
              const records = unsynced as Array<Record<string, unknown>>;
              // Minimal push progress (ticket e4049164): one \r line on a
              // TTY (counter + bar + pct + ETA), sparse lines when piped,
              // everything on stderr — the pre-push listing and the prompts
              // above stay byte-identical.
              const onProgress = createTaskPushProgressReporter(records.length);
              const data = await createTasksOneByOne(
                apiUrl,
                token,
                workspace.id,
                records,
                onProgress,
              );
              // Condensed summary (ticket e4049164): one line carries the
              // TRUE numbers (created/refused groups via
              // formatPushRefusalSummary — never "already existed"), the
              // stop line and the not-attempted count share one red line.
              const refused =
                data.skipped > 0 ? ` — ${formatPushRefusalSummary(data)}` : "";
              console.log(
                chalk.green(
                  `  ✓ Pushed ${data.imported} task${data.imported !== 1 ? "s" : ""} to ${workspace.name}${refused}`,
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
              const links = await applyPushLinks(apiUrl, token, records, data.idMap);
              if (links.applied > 0)
                console.log(
                  chalk.green(
                    `  ✓ Applied ${links.applied} link${links.applied !== 1 ? "s" : ""}`,
                  ),
                );
              if (links.skipped.length > 0)
                console.log(
                  chalk.dim(`    (${formatSkippedLinks(links.skipped, false)})`),
                );
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

export async function login(projectDir: string = resolve(".")): Promise<void> {
  const apiUrl = getApiUrl();
  console.log(chalk.cyan("  Initiating device login flow..."));

  let initRes: Response;
  try {
    // Step 1: Request device code
    // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
    initRes = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/auth/device-init")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

    // The device flow issues an `api_tokens` PAT directly: the server
    // mints it on authorization and returns the plaintext exactly once in
    // `{ token }`. There is no other token shape — the PAT is stored
    // verbatim and is the Bearer credential for every cloud call below
    // (`/api/v0` via `surfacePath("cloud", …)`).
    const data = (await pollRes.json()) as
      | { pending: true }
      | { token: string }
      | { expired: true };

    if ("token" in data) {
      const pat = data.token;
      await writeToken(pat);
      console.log();
      console.log(
        chalk.green("  Logged in successfully. Now operating in online mode."),
      );
      await Promise.all([
        fetchAndSelectWorkspace(apiUrl, pat),
        fetchAndApplySettings(apiUrl, pat),
      ]);
      // After login, ask if user wants to push local tasks
      const { readWorkspace } = await import("./workspace.js");
      const workspace = await readWorkspace();
      if (workspace) {
        await promptPushLocalTasks(projectDir, apiUrl, pat, workspace);
      }
      return;
    }

    if ("expired" in data) {
      console.error(chalk.red("  Device code expired. Please try again."));
      process.exitCode = ExitCode.AUTH;
      return;
    }

    // pending — keep polling
    process.stdout.write(chalk.dim("."));
  }

  console.error(chalk.red("\n  Login timed out. Please try again."));
  process.exitCode = ExitCode.AUTH;
}
