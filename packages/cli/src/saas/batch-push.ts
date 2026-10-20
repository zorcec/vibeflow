/**
 * Cloud batch-push client (ticket 8d3b2b81).
 *
 * WHAT: the tree-import counterpart to the one-by-one loop in
 * `auth/login.ts` (`createTasksOneByOne`) — probe → preflight →
 * chunked multipart `POST /api/v0/tasks/import` (tasks + parent links
 * + files in one call) → checkpointed idMap. One import call carries a
 * whole subtree, so children can never be orphaned by a failed
 * follow-up phase: at most IMPORT_MAX_TASKS tasks, IMPORT_MAX_FILES
 * files, IMPORT_MAX_BYTES bytes per chunk, per-task results in manifest
 * order, and `GET /api/v0/tasks/import` as the preflight probe
 * (tasks:read scope; a 404 on old servers doubles as the capability
 * probe, like the old tasks-batch probe before it).
 *
 * WHY a separate module (not folded into `auth/login.ts`): the batch path
 * is cloud-only and additive — the login-time prompt flow and every old
 * server keep the proven one-by-one loop byte-identical. `push.ts` probes
 * first and falls back on 404, so no breakage on old servers.
 *
 * Honesty/progress surfaces are WIRED THROUGH, not reinvented: the chunk
 * loop reports k/N through the caller's `onProgress` hook (the e4049164
 * reporter), per-item refusals group exactly like dec52322 (same
 * `{status, code, count}` shape, same first-seen order, same early stop
 * on 402/429), and `formatPushRefusalSummary`/`formatPushStopLine` render
 * both paths unchanged.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { surfacePath } from "../core/api-url.js";
import { scopeHeaderFor } from "../auth/board-scope.js";
import { PROTO_DIR } from "../core/types.js";
import { pushRefusalCode, resolve429WaitMs, PUSH_429_MAX_RESUMES, type Push429ResumeOptions } from "../auth/login.js";
import { maybeCompressForUpload } from "./compression.js";
import type { PushLoopResult, PushRefusalGroup } from "../auth/login.js";

/**
 * Max tasks per `POST /api/v0/tasks/import` (ticket bulk-429).
 * WHAT: one named constant for the client-side chunker, mirroring the
 * server's `V0_IMPORT_MAX_TASKS` (= 100) — the chunker below and the
 * BATCH_TOO_LARGE guard share it, so the cap lives in exactly one place.
 * WHY 100: a task with its children and files travels in one part of
 * one call; 100 tasks/chunk keeps a 1704-task push to ~18 import calls
 * instead of ~1058 single writes. The effective chunk size is
 * `min(IMPORT_MAX_TASKS, preflight.maxTasks)` — a plan may advertise a
 * smaller window, never a larger one.
 */
export const IMPORT_MAX_TASKS = 100;

/**
 * Max files per `POST /api/v0/tasks/import` (ticket bulk-429).
 * WHAT: mirrors the server's `V0_IMPORT_MAX_FILES` (= 50) — the chunker
 * below counts files per task and splits a task's file list across
 * chunks when one task alone would pass it (the server applies the
 * same manifest idempotently, so a split task's second chunk returns
 * `existing: true` and uploads the rest).
 * WHY 50: 782 files cost ~16 import calls instead of 782 single
 * uploads — the exact prod-incident ratio, pinned by the regression
 * test below.
 */
export const IMPORT_MAX_FILES = 50;

/**
 * Max total file bytes per `POST /api/v0/tasks/import` (ticket bulk-429).
 * WHAT: the chunker accumulates jobs until the next file would pass
 * this budget (disk sizes — a safe UPPER bound: eligible text rides
 * brotli-compressed, so the server-measured total never exceeds the
 * disk-size sum and a conforming chunk never trips the server's exact
 * `V0_IMPORT_MAX_BYTES` check).
 * WHY 25 MB: mirrors the server cap 1:1 so chunking is exact.
 */
export const IMPORT_MAX_BYTES = 25 * 1024 * 1024;

/** Per-chunk POST bound (ticket bulk-429): 60s, not 30s — a 25 MB
 * multipart body needs longer than a JSON chunk on a slow uplink.
 * Exceeded → the attempt throws and the retry policy below applies. */
export const IMPORT_CHUNK_TIMEOUT_MS = 60_000;

/** Chunk retry budget (ticket bulk-429): initial attempt + 2 retries.
 * WHAT: retries cover transport failures (throw/timeout) and 5xx only —
 * 4xx is a caller/auth story (no retry: 402/429 stop the push, other 4xx
 * degrade to per-task failures for the chunk's tasks, mirroring the
 * one-by-one loop where a non-ok NEVER retries).
 * WHY 3 total: one retry is not enough to ride out a rolling restart;
 * unbounded retry on a 1704-task push could hammer a sick server for
 * hours. A 5xx that survives all 3 attempts degrades to per-task
 * failures (push continues, loudly) — only a dead transport fails the
 * push. */
export const IMPORT_CHUNK_MAX_ATTEMPTS = 3;

/** Linear backoff between chunk retries: 500ms × attempt (ticket bulk-429).
 * Small enough to keep a bulk push fast, large enough not to hot-loop a
 * recovering server. */
export const IMPORT_CHUNK_RETRY_DELAY_MS = 500;

/** Capability-probe bound (ticket bulk-429): one cheap GET — 15s, not
 * 30s, because the probe gates the whole push and must fail fast. */
export const IMPORT_PROBE_TIMEOUT_MS = 15_000;

/** Inter-chunk pacing breather (ticket 7fa3ef3b): delay between chunk
 * POSTs so back-to-back 100-task inserts + broadcasts don't saturate the
 * small box and disturb other users.
 * WHY 5000: one chunk per 5s is far below any plan's write budget now that
 * a batch costs 1 unit per call, yet keeps a 1694-task push to ~2 minutes
 * while giving the small box room to breathe between bulk inserts.
 * 0 disables. Skipped before the first POSTed chunk and on 429-resume
 * re-POSTs (which already waited out a Retry-After). */
export const BATCH_CHUNK_PACING_DELAY_MS = 5_000;

/** Checkpoint file name (ticket 8d3b2b81): lives at
 * `<projectDir>/.vibeflow/push-batch.checkpoint.json` — next to, never
 * inside, `.vibeflow/tasks/`, so the task listing never picks it up as a
 * task and the post-push deletion (task files + asset dirs only) never
 * touches it; completion deletes it explicitly. */
export const BATCH_CHECKPOINT_FILENAME = "push-batch.checkpoint.json";

export function batchCheckpointPath(projectDir: string): string {
  return join(projectDir, PROTO_DIR, BATCH_CHECKPOINT_FILENAME);
}

/** Preflight envelope of `GET /api/v0/tasks/import` (ticket bulk-429):
 * remaining capacity BEFORE chunk one + the caps the chunker honors.
 * Limits (and remainings) are null when the plan caps nothing on that
 * dimension. */
export interface ImportPreflight {
  maxTasks: number;
  maxFiles: number;
  maxBytes: number;
  /** Per-file byte cap from the plan (`maxFileBytes` entitlement) — null
   * when the plan caps nothing per file. Absent on old-server envelopes
   * (treated as null = uncapped) so the probe stays backward-compatible. */
  maxFileBytes: number | null;
  plan: string;
  openLimit?: number | null;
  openUsed?: number;
  openRemaining?: number | null;
  totalLimit?: number | null;
  totalUsed?: number;
  totalRemaining?: number | null;
}

export type ImportProbeResult =
  | {
      supported: true;
      preflight: ImportPreflight;
      /**
       * The server mirrors the WHOLE local record, not a fields subset.
       *
       * This is what makes a re-push a repair: an existing task has to be sent
       * again so the server can reconcile comments, commits, links and
       * `openedBy` that an older lossy import dropped. Without the flag the
       * CLI keeps the old, conservative behaviour (only missing tasks travel).
       */
      lossless: boolean;
    }
  | { supported: false };

export interface BatchCheckpoint {
  version: 1;
  /** Local task ids in push order — resume requires an EXACT match. */
  order: string[];
  /** Items fully processed (always chunk-aligned; written per chunk). */
  attempted: number;
  /** localId → cloudId for every created task so far. */
  idMap: Record<string, string>;
}

/** Legacy-path spelling of the import endpoint (ticket bulk-429): every
 * cloud URL in this module goes through `surfacePath("cloud", …)` — the
 * single prefix table in `core/api-url.ts` — so `/api/cli/tasks/import`
 * maps to `/api/v0/tasks/import` exactly like `/api/cli/tasks` maps to
 * `/api/v0/tasks`. Old servers never had it → 404 → the probe's
 * unsupported branch. */
const IMPORT_LEGACY_PATH = "/api/cli/tasks/import";

/** SSRF/credential-leak guard (ticket 8d3b2b81): `getApiUrl()` already
 * constrains the base to well-formed http(s), but this module builds its
 * own outbound URLs — so every entry point re-validates the base before
 * the first fetch. A Bearer token must never travel to a file://, custom
 * scheme, or malformed host, no matter who constructed `apiUrl`. */
function requireHttpBase(apiUrl: string): string {
  let protocol = "";
  try {
    protocol = new URL(apiUrl).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error(
      "batch push refused: API base is not a well-formed http(s) URL",
    );
  }
  return apiUrl.replace(/\/+$/, "");
}

function importUrl(apiUrl: string): string {
  return `${requireHttpBase(apiUrl)}${surfacePath("cloud", IMPORT_LEGACY_PATH)}`;
}

/**
 * Scope header for accounts with more than one board.
 *
 * The one spelling is `scopeHeaderFor` in auth/board-scope.ts (ticket
 * dabd2fb7) — the header contract dates from ticket 1181d2b, where the
 * missing scope turned every multi-board push into a bare "HTTP 422".
 */
const scopeHeaders = scopeHeaderFor;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capability probe (ticket bulk-429): `GET /api/v0/tasks/import`.
 * - 200 WITH the preflight envelope → `{ supported: true, preflight }`.
 * - 200 WITHOUT the preflight envelope → `{ supported: false }` (LENIENT —
 *   an old server's router prefix-matches `/tasks/import` onto the list
 *   handler and answers 200 `{ items, nextCursor }`; same leniency
 *   rationale as the old tasks-batch probe: a throwing probe would brick
 *   push against such servers, defeating the fallback's purpose).
 * - 404 → `{ supported: false }` — an old server; the caller falls back
 *   to the legacy phases. The 404 body is never parsed (old servers
 *   answer HTML here; parsing it would throw a confusing SyntaxError).
 * - 401/403 → THROW (bad token must abort BEFORE any destructive step —
 *   falling back would "push" 0 tasks and the post-push deletion would
 *   still wipe locals).
 * - any other non-ok (incl. 5xx and non-legacy 400s) → THROW (unknown
 *   server state — abort loudly rather than blind-attempt a tree import;
 *   the message carries the status).
 * - transport throw/timeout → propagates (callers report it as a failed
 *   push, same as the one-by-one loop's network-throw contract).
 */
export async function probeImportCapability(
  apiUrl: string,
  token: string,
  boardId?: string,
): Promise<ImportProbeResult> {
  const res = await fetch(importUrl(apiUrl), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, ...scopeHeaders(boardId) },
    signal: AbortSignal.timeout(IMPORT_PROBE_TIMEOUT_MS),
  });
  if (res.status === 404) return { supported: false };
  if (res.status === 400) {
    // Old-server alias artifact: the LOCAL board's v0 read-alias
    // rewrites GET /api/v0/tasks/import onto the legacy
    // `/api/tasks/:id` handler, which rejects the literal id "import"
    // with 400 `{ error: "Invalid task id" }` — semantically the same
    // "no import here" as a 404, so it falls back too.
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body?.error === "Invalid task id") return { supported: false };
    } catch {
      /* unparseable 400 → fall through to the loud throw */
    }
  }
  if (res.status === 422) {
    // The account has several boards and none is selected. This is NOT a
    // transport failure: say what to do, because "HTTP 422" sent the owner
    // hunting for a network problem.
    let code = "";
    try {
      const body = (await res.json()) as { code?: unknown; error?: unknown };
      code = typeof body.code === "string" ? body.code : "";
    } catch {
      /* unparseable body: fall through to the generic hint */
    }
    throw new Error(
      code === "SCOPE_REQUIRED" || code === ""
        ? "this account has more than one board and none is selected — run `vibeflow auth login` to pick one, or `vibeflow push --workspace <boardId>`"
        : `tree-import capability probe rejected the request: HTTP 422${code ? ` (${code})` : ""}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `tree-import capability probe failed: HTTP ${res.status} (only 404 falls back to the legacy phases; auth/transport failures abort the push)`,
    );
  }
  const body = (await res.json()) as Partial<ImportPreflight> & Record<string, unknown>;
  if (typeof body?.maxTasks !== "number" || typeof body?.plan !== "string") {
    return { supported: false };
  }
  return {
    supported: true,
    lossless: body.lossless === true,
    preflight: {
      maxTasks: body.maxTasks,
      maxFiles: typeof body.maxFiles === "number" ? body.maxFiles : IMPORT_MAX_FILES,
      maxBytes: typeof body.maxBytes === "number" ? body.maxBytes : IMPORT_MAX_BYTES,
      maxFileBytes:
        typeof body.maxFileBytes === "number"
          ? body.maxFileBytes
          : null,
      plan: body.plan,
      openLimit: typeof body.openLimit === "number" ? body.openLimit : null,
      openUsed: typeof body.openUsed === "number" ? body.openUsed : 0,
      openRemaining:
        typeof body.openRemaining === "number" ? body.openRemaining : null,
      totalLimit: typeof body.totalLimit === "number" ? body.totalLimit : null,
      totalUsed: typeof body.totalUsed === "number" ? body.totalUsed : 0,
      totalRemaining:
        typeof body.totalRemaining === "number" ? body.totalRemaining : null,
    },
  };
}

/**
 * Paginated online-id fetch (diff-based push).
 * WHAT: the ONE shared helper for "which task ids are already on the
 * board" — `GET /api/v0/tasks?boardId=…&limit=100`, following
 * `nextCursor` to exhaustion (bounded at 200 pages so a server echoing
 * one cursor forever cannot hang the caller), collecting every id-like
 * key (`id`, `externalId`, `cloudId`, `cliId`) into a Set. A local task
 * matching ANY of them counts as already synced.
 * WHY one helper: the login-time prompt (`auth/login.ts`) and the
 * standalone `push` command both need exactly this diff — an inline
 * copy in each would drift (the 1746-task board re-push incident was a
 * first-page-only read) — so both call this, and only this.
 * Transport/auth failures propagate: the caller decides (push treats a
 * failed listing as "attempt everything, said out loud"; login labels
 * its prompt the same way). Never falls back silently here.
 */
export const ONLINE_IDS_PAGE_LIMIT = 100;
export const ONLINE_IDS_MAX_PAGES = 200;

export async function fetchOnlineTaskIds(
  apiUrl: string,
  token: string,
  boardId: string,
): Promise<Set<string>> {
  return new Set((await fetchOnlineTaskIndex(apiUrl, token, boardId)).keys());
}

/**
 * Paginated board index: every id-like key a remote task answers to, mapped
 * to that task's `fileCount` (null when the row carries no count).
 *
 * WHY the count matters (ticket push-diff-atomic follow-up): the diff used
 * to be id-only, so a task that exists remotely but whose FILES failed to
 * upload was permanently excluded from every later push — the "retry next
 * time" promise held for tasks but not for their files. Measured on prod:
 * 1746 tasks synced while only 601 of ~790 files were on the board, and the
 * push reported "everything is already pushed".
 *
 * The comparison is deliberately by COUNT, not by name: names would need one
 * extra GET per task (1746 requests). Count plus the server's skip-if-present
 * upload is enough to converge — a task with fewer remote files than local
 * ones is re-pushed, its task row comes back `existing`, and only the missing
 * bytes travel. A locally deleted file leaves remoteCount > localCount, which
 * is not a reason to re-push and is correctly ignored.
 */
export async function fetchOnlineTaskIndex(
  apiUrl: string,
  token: string,
  boardId: string,
): Promise<Map<string, number | null>> {
  const index = new Map<string, number | null>();
  const headers = { Authorization: `Bearer ${token}` };
  const listPath = surfacePath("cloud", "/api/cli/tasks");
  let cursor: string | null = null;
  for (let page = 0; page < ONLINE_IDS_MAX_PAGES; page++) {
    const qs = new URLSearchParams({ boardId, limit: String(ONLINE_IDS_PAGE_LIMIT) });
    if (cursor !== null) qs.set("cursor", cursor);
    const res = await fetch(`${requireHttpBase(apiUrl)}${listPath}?${qs.toString()}`, {
      headers,
    });
    if (!res.ok) {
      throw new Error(`board listing failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      items?: Array<Record<string, unknown>>;
      tasks?: Array<Record<string, unknown>>;
      nextCursor?: unknown;
    };
    const rows = Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.tasks)
        ? data.tasks
        : [];
    for (const t of rows) {
      const raw = (t as Record<string, unknown>).fileCount;
      const count = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      for (const key of ["id", "externalId", "cloudId", "cliId"]) {
        const v = (t as Record<string, unknown>)[key];
        if (typeof v === "string" && v.length > 0) index.set(v, count);
      }
    }
    const next =
      typeof data.nextCursor === "string" && data.nextCursor.length > 0
        ? data.nextCursor
        : null;
    if (next === null || next === cursor || rows.length === 0) break;
    cursor = next;
  }
  return index;
}

/**
 * Quota preflight gate (ticket 8d3b2b81, reused by tree import):
 * refuse-or-confirm BEFORE chunk one instead of discovering the cap
 * mid-push.
 * WHAT: returns a refusal message when the push cannot fit in the
 * remaining capacity, else null.
 * WHY refuse-only (no interactive confirm): the login-time push runs
 * inside a readline flow AND the `push` command runs in scripts — a
 * prompt cannot work in both — and the dec52322 rule is "never start a
 * push that cannot succeed". The caller prints the message (exact
 * numbers, both dimensions) and aborts; the user frees quota or pushes
 * fewer tasks and re-runs. `null` limits/remaining = uncapped dimension.
 * The preflight shape is structural (not the old `BatchPreflight`):
 * the import probe's envelope satisfies it, and so did the old one.
 */
export function evaluateBatchPreflight(
  remaining: number,
  preflight: {
    plan: string;
    openRemaining?: number | null;
    totalRemaining?: number | null;
  },
): string | null {
  if (
    typeof preflight.openRemaining === "number" &&
    remaining > preflight.openRemaining
  ) {
    return (
      `Preflight refusal: board has ${preflight.openRemaining} open task slot(s) ` +
      `remaining (plan ${preflight.plan}) but the push needs ${remaining}. ` +
      `Refusing before chunk one — free quota or push fewer tasks and re-run.`
    );
  }
  if (
    typeof preflight.totalRemaining === "number" &&
    remaining > preflight.totalRemaining
  ) {
    return (
      `Preflight refusal: board has ${preflight.totalRemaining} total task slot(s) ` +
      `remaining (plan ${preflight.plan}) but the push needs ${remaining}. ` +
      `Refusing before chunk one — free quota or push fewer tasks and re-run.`
    );
  }
  return null;
}

/**
 * Map a per-item batch error code to its honest HTTP status (ticket 8d3b2b81).
 * WHAT: the batch envelope is always 200 past request validation, so a
 * per-item `{ error: { code, message } }` carries no status — but the
 * dec52322 grouped summary renders `${status} ${code} ×${n}` and the
 * early-stop rule keys on 402/429.
 * WHY this mapping: the contract itself names per-item quota hits "402
 * TASK_LIMIT", and every other per-item failure is the single-create
 * validation (400) or the token bucket (429) the one-by-one loop already
 * groups under those statuses. Unknown codes default to 400 (a refused
 * item is a validation story unless the code says limit/quota/rate).
 */
export function batchItemHttpStatus(code: string): number {
  const c = code.toUpperCase();
  if (c.includes("TASK_LIMIT") || c.includes("PLAN_LIMIT") || c.includes("QUOTA") || c === "402") return 402;
  if (c.includes("RATE") || c.includes("TOO_MANY") || c.includes("429")) return 429;
  return 400;
}

/** Read + validate the checkpoint (ticket 8d3b2b81): corrupt/foreign
 * shapes return null (discard, start fresh) — a half-written JSON from a
 * killed process must never crash the next push. */
export function readBatchCheckpoint(projectDir: string): BatchCheckpoint | null {
  let raw: string;
  try {
    raw = readFileSync(batchCheckpointPath(projectDir), "utf-8");
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw) as Partial<BatchCheckpoint>;
    if (
      data.version !== 1 ||
      !Array.isArray(data.order) ||
      !data.order.every((id) => typeof id === "string") ||
      typeof data.attempted !== "number" ||
      !Number.isInteger(data.attempted) ||
      data.attempted < 0 ||
      typeof data.idMap !== "object" ||
      data.idMap === null
    ) {
      return null;
    }
    return {
      version: 1,
      order: data.order,
      attempted: data.attempted,
      idMap: data.idMap as Record<string, string>,
    };
  } catch {
    return null;
  }
}

/** Best-effort checkpoint write (ticket 8d3b2b81): a checkpoint failure
 * must never fail the push it is recording — the push continues without
 * resume coverage and the next run starts fresh. */
export function writeBatchCheckpoint(
  projectDir: string,
  checkpoint: BatchCheckpoint,
): void {
  try {
    mkdirSync(join(projectDir, PROTO_DIR), { recursive: true });
    writeFileSync(
      batchCheckpointPath(projectDir),
      JSON.stringify(checkpoint),
    );
  } catch {
    /* best-effort — the push continues, resume just unavailable */
  }
}

export function clearBatchCheckpoint(projectDir: string): void {
  try {
    if (existsSync(batchCheckpointPath(projectDir))) {
      rmSync(batchCheckpointPath(projectDir));
    }
  } catch {
    /* best-effort */
  }
}

/* ── Tree import client (ticket bulk-429) ───────────────────────────
 *
 * WHAT: chunked multipart `POST /api/v0/tasks/import` — one call carries
 * a whole subtree (tasks + parent links + files), so children can never
 * be orphaned by a failed follow-up phase and a 1704-task push costs ~20
 * calls instead of ~1058 single writes. Parents resolve in-manifest
 * first, else remotely board-scoped (cliId-first — parents from earlier
 * chunks/runs heal with no follow-up phase), else a per-task link error.
 *
 * Skip-if-present lives SERVER-side now (deliberate move, not a drop):
 * the old client presence phase cost N GETs against the 60/min read
 * bucket — at push scale it 429'd and failed open (uploaded everything
 * anyway). The import endpoint reads the task's name index ONCE per call
 * and skips present names without storing, so a re-push re-sends bytes
 * but stores nothing twice and the counts stay honest. Same resume
 * safety, one indexed read per call instead of N GETs.
 *
 * Honesty/pacing/resume mirror `createTasksInBatches` (now removed):
 * k/N progress, dec52322 refusal groups, 5s inter-chunk pacing, bounded
 * Retry-After resume (resolve429WaitMs + PUSH_429_MAX_RESUMES).
 */

/** One file attachment for an import task. */
export interface ImportFileInput {
  name: string;
  filePath: string;
  size: number;
  system: boolean;
}

/** One task's import payload: push record + local files. */
export interface ImportTaskInput {
  /** Local task id (travels as the manifest `clientId`, stored as `cliId`). */
  localId: string;
  /** Parsed task JSON record (fields travel verbatim; the server validates). */
  record: Record<string, unknown>;
  /** Local file attachments for this task. */
  files: ImportFileInput[];
}

/** One manifest chunk: task inputs sliced for a single import call. */
export interface ImportChunk {
  tasks: ImportTaskInput[];
}

/**
 * Keys that exist only in memory and must never travel to the server.
 *
 * `filePath` is added by listTasksWithPaths for the file phase; persisting it
 * would leak an absolute local path into the cloud record. `authStateEnc` is
 * captured browser auth state (a credential) written by the overlay — the
 * server strips it too, but it must not leave the machine at all.
 */
const RUNTIME_ONLY_RECORD_KEYS = new Set(["filePath", "authStateEnc"]);

/**
 * The record as it should be mirrored: the local task JSON minus runtime-only
 * keys. Lossless push sends this whole object so the server can store it as
 * `raw` and project every field, instead of the fixed subset that silently
 * dropped comments/commits/openedBy/non-parent links (measured: 3147
 * comments, 1436 commits and 20 links lost).
 */
export function recordForWire(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (RUNTIME_ONLY_RECORD_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? recordForWire(item as Record<string, unknown>)
          : item,
      );
    } else if (typeof value === "object" && value !== null) {
      out[key] = recordForWire(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function parentLinkTargets(record: Record<string, unknown>): string[] {
  const links = record.links;
  if (!Array.isArray(links)) return [];
  const out: string[] = [];
  for (const link of links) {
    if (
      typeof link === "object" &&
      link !== null &&
      (link as Record<string, unknown>).type === "parent" &&
      typeof (link as Record<string, unknown>).taskId === "string" &&
      ((link as Record<string, unknown>).taskId as string).length > 0
    ) {
      // SAFETY: the guard above already narrowed `link` to a non-null object
      // whose `taskId` is a non-empty string, so this assertion only restates
      // a fact TypeScript cannot carry across the compound condition.
      out.push((link as unknown as { taskId: string }).taskId);
    }
  }
  return out;
}

/**
 * Order tasks parents-first (ticket bulk-429).
 * WHAT: stable topological order over the LOCAL parent links — Kahn's
 * algorithm with input-order tie-breaking, so unrelated tasks keep push
 * order and only parent/child pairs move.
 * WHY parents-first: chunks push oldest-first and a server-side parent
 * resolves from an earlier chunk via the board (or in-manifest for the
 * same chunk) — a child-first order would strand every cross-chunk
 * parent as a link error. Cycles (A↔B locally) cannot order; leftovers
 * append in input order and the server reports the cycle as a per-task
 * link error — loud, never silent. A task's FIRST in-push parent wins
 * the ordering edge; extras still travel (manifest array) and resolve
 * the same way.
 */
export function topoOrderImportTasks<
  T extends { localId: string; record: Record<string, unknown> },
>(inputs: T[]): T[] {
  const byId = new Map(inputs.map((t) => [t.localId, t]));
  const parentOf = new Map<T, T | null>();
  for (const t of inputs) {
    let parent: T | null = null;
    for (const target of parentLinkTargets(t.record)) {
      if (target === t.localId) continue;
      const p = byId.get(target);
      if (p !== undefined) {
        parent = p;
        break;
      }
    }
    parentOf.set(t, parent);
  }
  const children = new Map<T, T[]>();
  const pending = new Map<T, number>();
  for (const t of inputs) {
    children.set(t, []);
    pending.set(t, 0);
  }
  for (const t of inputs) {
    const p = parentOf.get(t);
    if (p !== null && p !== undefined) {
      children.get(p)!.push(t);
      pending.set(t, 1);
    }
  }
  const ready = inputs.filter((t) => pending.get(t) === 0);
  const out: T[] = [];
  const done = new Set<T>();
  while (ready.length > 0) {
    const t = ready.shift()!;
    out.push(t);
    done.add(t);
    for (const c of children.get(t)!) {
      pending.set(c, (pending.get(c) ?? 1) - 1);
      if (pending.get(c) === 0 && !done.has(c)) ready.push(c);
    }
  }
  // Cycle leftovers (never orderable): input order, server reports them.
  for (const t of inputs) {
    if (!done.has(t)) out.push(t);
  }
  return out;
}

/**
 * Slice import tasks into manifest chunks (ticket bulk-429). Pure.
 * WHAT: greedy fill in (topo) order — a task joins the current chunk
 * while tasks/files/bytes all fit; otherwise the chunk flushes and the
 * task starts the next one. A single task that alone passes the file or
 * byte cap has its FILE LIST split across chunks (same record repeats;
 * the server answers `existing: true` for the replay and uploads the
 * rest) — caps are per CALL, never per task, and the splitter guarantees
 * progress (≥1 file per chunk) so it can never spin.
 * WHY greedy + splitting: 782 files must cost ~16 calls with zero 429s
 * (the regression test pins the math); a pathological 60-file task must
 * not 400 every chunk it touches.
 */
/** One task the import path refused to attempt (per-task atomicity). */
export interface SkippedImportTask {
  /** Local task id — never recorded as done, so the next run retries it. */
  localId: string;
  /** Exact reason: file name + size vs the cap it hit. */
  reason: string;
}

export interface ImportChunkCaps {
  maxTasks: number;
  maxFiles: number;
  maxBytes: number;
  /** Per-file byte cap (null = uncapped plan) — from the preflight. */
  maxFileBytes?: number | null;
}

/** Disk-size of one file entry (negative/NaN sizes read as 0). */
export function importFileSize(f: ImportFileInput): number {
  return Number.isFinite(f.size) && f.size >= 0 ? f.size : 0;
}

/** Disk-size sum of a task's files (safe UPPER bound for the wire —
 * eligible text rides brotli-compressed, so the server-measured total
 * never exceeds this sum). */
export function importTaskBytes(t: ImportTaskInput): number {
  return t.files.reduce((a, f) => a + importFileSize(f), 0);
}

/**
 * Per-task atomicity gate: split import inputs into pushable tasks and
 * tasks that cannot fully fit and must be SKIPPED WHOLE — never created
 * partially. A task is skipped when ANY holds:
 * - one of its files exceeds the server's per-file cap (`maxFileBytes`),
 * - its files' total exceeds the per-request byte cap (`maxBytes`),
 * - its file count exceeds the per-request file cap (`maxFiles`) — i.e.
 *   it cannot fit the chunk budget even when the chunk is empty.
 * Fileless tasks always pass (one task always fits an empty chunk).
 * Skipped tasks carry the exact reason (file name + size vs cap) and
 * are retryable: callers must NOT record them as done (no checkpoint,
 * no idMap, no local deletion) so the next run re-attempts them.
 * Pure. Caps fall back to the IMPORT_MAX_* constants; a null/absent
 * `maxFileBytes` means the plan caps nothing per file (no file ever
 * skips on that rule).
 */
export function partitionImportInputs(
  inputs: ImportTaskInput[],
  caps: ImportChunkCaps,
): { pushable: ImportTaskInput[]; skipped: SkippedImportTask[] } {
  const mf =
    Math.floor(caps.maxFiles) >= 1 ? Math.floor(caps.maxFiles) : IMPORT_MAX_FILES;
  const mb =
    Math.floor(caps.maxBytes) >= 1 ? Math.floor(caps.maxBytes) : IMPORT_MAX_BYTES;
  const mfb =
    typeof caps.maxFileBytes === "number" &&
    Number.isFinite(caps.maxFileBytes) &&
    caps.maxFileBytes >= 0
      ? caps.maxFileBytes
      : null;
  const pushable: ImportTaskInput[] = [];
  const skipped: SkippedImportTask[] = [];
  for (const t of inputs) {
    const oversize = mfb !== null ? t.files.find((f) => importFileSize(f) > mfb) : undefined;
    if (oversize !== undefined) {
      skipped.push({
        localId: t.localId,
        reason:
          `file "${oversize.name}" (${importFileSize(oversize)} bytes) ` +
          `exceeds the per-file cap of ${mfb} bytes — task skipped whole, retryable`,
      });
      continue;
    }
    const bytes = importTaskBytes(t);
    if (bytes > mb) {
      skipped.push({
        localId: t.localId,
        reason:
          `task files total ${bytes} bytes exceeds the per-request cap of ` +
          `${mb} bytes — task skipped whole, retryable`,
      });
      continue;
    }
    if (t.files.length > mf) {
      skipped.push({
        localId: t.localId,
        reason:
          `task has ${t.files.length} file(s), exceeding the per-request cap of ` +
          `${mf} — task skipped whole, retryable`,
      });
      continue;
    }
    pushable.push(t);
  }
  return { pushable, skipped };
}

/**
 * Slice import tasks into manifest chunks. Pure and TASK-ATOMIC: greedy
 * fill in (topo) order — a task joins the current chunk while
 * tasks/files/bytes all fit, else the chunk flushes and the task starts
 * the next one. A task's file list is NEVER split across chunks: a task
 * that cannot fully fit is skipped whole by `partitionImportInputs`
 * BEFORE chunking (the server would otherwise create the task with only
 * some of its files — a partial task that reads as synced). A task that
 * still does not fit an EMPTY chunk (caller skipped the partition —
 * defensive only) travels alone so the chunker always makes progress
 * and the server refuses it loudly as one whole-chunk verdict.
 */
export function chunkImportTasks(
  inputs: ImportTaskInput[],
  maxTasks: number,
  maxFiles: number = IMPORT_MAX_FILES,
  maxBytes: number = IMPORT_MAX_BYTES,
): ImportChunk[] {
  const mt = Math.floor(maxTasks) >= 1 ? Math.floor(maxTasks) : IMPORT_MAX_TASKS;
  const mf = Math.floor(maxFiles) >= 1 ? Math.floor(maxFiles) : IMPORT_MAX_FILES;
  const mb = Math.floor(maxBytes) >= 1 ? Math.floor(maxBytes) : IMPORT_MAX_BYTES;
  const chunks: ImportChunk[] = [];
  let cur: ImportTaskInput[] = [];
  let curFiles = 0;
  let curBytes = 0;
  const flush = (): void => {
    if (cur.length > 0) {
      chunks.push({ tasks: cur });
      cur = [];
      curFiles = 0;
      curBytes = 0;
    }
  };
  for (const t of inputs) {
    const tb = importTaskBytes(t);
    const wholeFits =
      cur.length + 1 <= mt &&
      curFiles + t.files.length <= mf &&
      curBytes + tb <= mb;
    if (wholeFits) {
      cur.push(t);
      curFiles += t.files.length;
      curBytes += tb;
      continue;
    }
    flush();
    cur.push(t);
    curFiles = t.files.length;
    curBytes = tb;
    if (curFiles >= mf || curBytes >= mb) flush();
  }
  flush();
  return chunks;
}

export interface ImportBatchOptions {
  /** k/N reporter (the e4049164 factory) — called per completed task
   * with ABSOLUTE counts (resume base included) over the FULL total. */
  onProgress?: (done: number, total: number) => void;
  /** Project dir for the checkpoint file. Omit ONLY when the caller has
   * no project dir (then resume is unavailable but the push still runs). */
  projectDir?: string;
  /** Preflight (chunk sizing + nothing else — the refuse gate lives in
   * `evaluateBatchPreflight`, called by push.ts BEFORE this runs).
   * `preflight.maxFileBytes` (null = uncapped) feeds the per-task
   * atomicity partition; `maxFileBytes` below overrides it (tests). */
  preflight?: ImportPreflight;
  /** Per-file byte cap override for the atomicity partition (tests pin
   * skips without a live preflight; callers prefer the preflight). */
  maxFileBytes?: number | null;
  /** 429 wait-resume knobs (ticket bulk-429): same shape and defaults as
   * the task loops — one shared per-push budget of 3 waits. */
  retry429?: Push429ResumeOptions;
  /** Inter-chunk pacing delay override (defaults to
   * BATCH_CHUNK_PACING_DELAY_MS; 0 disables). */
  pacingDelayMs?: number;
  /** Pacing sleeper override (defaults to real sleep; tests inject a
   * recorder). */
  pacingSleepMs?: (ms: number) => Promise<void>;
}

export interface ImportLoopResult extends PushLoopResult {
  linksApplied: number;
  linksFailed: number;
  failedLinks: Array<{ clientId: string; reason: string }>;
  filesUploaded: number;
  filesFailed: number;
  filesSkippedPresent: number;
  failedFiles: Array<{ clientId: string; name: string; reason: string }>;
  /** Tasks skipped WHOLE by the atomicity partition (never attempted,
   * never in the checkpoint/idMap — the next run re-attempts them).
   * A file that fails SERVER-side is NOT here: it lands in `failedFiles`
   * (partially-failed task, reported loudly) while its task still counts
   * as created — the skip list is only for tasks refused BEFORE chunk one. */
  skippedTasks: SkippedImportTask[];
}

export type ImportTaskOutcome =
  | {
      clientId: string;
      id?: string;
      existing?: true;
      error?: { code: string; message: string };
      links?: Array<
        | { type: string; taskId: string }
        | { error: { code: string; message: string } }
      >;
      files?: Array<
        | { ref: string; name: string; file: unknown }
        | { ref: string; name: string; skipped: true; file: unknown }
        | { ref: string; name: string; error: { code: string; message: string } }
      >;
    };

interface ImportChunkOutcome {
  /** Per-task results in manifest order. */
  taskResults: ImportTaskOutcome[];
  /** Whole-chunk non-ok (4xx/5xx-exhausted): every task failed alike. */
  wholeChunkRefusal: { status: number; code: string } | null;
  rateLimited: boolean;
  retryAfterHeader: string | null;
  stopCode: string | null;
  transportError: string | null;
}

/**
 * POST one import chunk as multipart `.../tasks/import` (ticket bulk-429).
 * Files are read + single-encode compressed up front (same
 * `maybeCompressForUpload` rule as the legacy uploader); the `br` claim
 * rides the manifest entry (`encoding: "br"` — multipart parts carry no
 * per-part headers) and the server runs the same per-file rules on
 * either shape. An unreadable file never blocks its chunk: the part is
 * left out and the file takes a client-side READ_ERROR after the POST.
 * Transport throws and 5xx retry to IMPORT_CHUNK_MAX_ATTEMPTS (linear
 * 500ms backoff); 429 resumes at the loop level; anything else degrades
 * to a whole-chunk refusal the loop fans out per task.
 */
async function postImportChunk(
  apiUrl: string,
  token: string,
  boardId: string | undefined,
  chunk: ImportChunk,
): Promise<ImportChunkOutcome> {
  const fileParts: Array<{
    ref: string;
    name: string;
    system: boolean;
    payload: Buffer;
    encoding: "br" | null;
  }> = [];
  // ref → read failure (overlaid onto the task's file results post-POST).
  const readErrors = new Map<string, { clientId: string; name: string; reason: string }>();
  const usedRefs = new Set<string>();
  const manifestTasks: Array<Record<string, unknown>> = [];
  for (const t of chunk.tasks) {
    const files: Array<Record<string, unknown>> = [];
    for (const f of t.files) {
      const ref = `${t.localId}/${f.name}`;
      if (usedRefs.has(ref)) {
        readErrors.set(ref, {
          clientId: t.localId,
          name: f.name,
          reason: "duplicate file name in task",
        });
        continue;
      }
      usedRefs.add(ref);
      try {
        const data = readFileSync(f.filePath);
        const { bytes: payload, contentEncoding } = maybeCompressForUpload(
          f.name,
          data,
        );
        fileParts.push({ ref, name: f.name, system: f.system, payload, encoding: contentEncoding });
        files.push({
          ref,
          name: f.name,
          ...(f.system ? { system: true } : {}),
          ...(contentEncoding === "br" ? { encoding: "br" } : {}),
        });
      } catch (err) {
        readErrors.set(ref, {
          clientId: t.localId,
          name: f.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // ONE sanitized wire record, used for BOTH representations. Sending the
    // raw `t.record` as `fields` (as this did at first) leaked the captured
    // `authStateEnc` credential and the absolute local `filePath` to the
    // server even though `record` was clean — sanitizing one field while the
    // other carried the original is not sanitizing.
    const wireRecord = recordForWire(t.record);
    manifestTasks.push({
      clientId: t.localId,
      // `fields` stays for old servers; `record` is the lossless payload a
      // server that advertises `lossless: true` mirrors verbatim.
      record: wireRecord,
      fields: wireRecord,
      // Every in-push parent travels (in-chunk or not — the server
      // resolves manifest siblings first, then the board remotely, so
      // cross-chunk and cross-run parents heal with no follow-up phase).
      parentClientIds: parentLinkTargets(t.record),
      files,
    });
  }

  const url = `${requireHttpBase(apiUrl)}${surfacePath("cloud", IMPORT_LEGACY_PATH)}`;
  for (let attempt = 1; attempt <= IMPORT_CHUNK_MAX_ATTEMPTS; attempt++) {
    const form = new FormData();
    form.append(
      "manifest",
      JSON.stringify({
        ...(boardId !== undefined ? { boardId } : {}),
        tasks: manifestTasks,
      }),
    );
    for (const p of fileParts) {
      // SAFETY: Node's Buffer is a Uint8Array, which is a valid BlobPart at
      // runtime; the DOM lib types BlobPart more narrowly than Node's Buffer,
      // so the assertion bridges the two lib.d.ts views of the same bytes.
      form.append(p.ref, new File([p.payload as unknown as BlobPart], p.name));
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(IMPORT_CHUNK_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt < IMPORT_CHUNK_MAX_ATTEMPTS) {
        await sleep(IMPORT_CHUNK_RETRY_DELAY_MS * attempt);
        continue;
      }
      return {
        taskResults: [],
        wholeChunkRefusal: null,
        rateLimited: false,
        retryAfterHeader: null,
        stopCode: null,
        transportError: err instanceof Error ? err.message : String(err),
      };
    }

    if (res.ok) {
      const envelope = (await res.json().catch(() => null)) as {
        results?: unknown;
      } | null;
      const raw = Array.isArray(envelope?.results) ? envelope!.results! : [];
      const taskResults: ImportTaskOutcome[] = chunk.tasks.map((t, i) => {
        const entry = raw[i] as ImportTaskOutcome | undefined;
        if (entry !== undefined && typeof entry === "object" && entry !== null) {
          return entry;
        }
        // Contract breach (short envelope): refuse the task loudly —
        // never misalign the idMap.
        return {
          clientId: t.localId,
          error: {
            code: "BATCH_MISSING_RESULT",
            message: "server returned fewer results than tasks",
          },
        };
      });
      // Overlay client-side read errors onto their task's file list.
      for (const [ref, detail] of readErrors) {
        const idx = chunk.tasks.findIndex((t) => t.localId === detail.clientId);
        if (idx === -1) continue;
        const tr = taskResults[idx]!;
        const files = Array.isArray(tr.files) ? [...tr.files] : [];
        files.push({ ref, name: detail.name, error: { code: "READ_ERROR", message: detail.reason } });
        tr.files = files;
      }
      return {
        taskResults,
        wholeChunkRefusal: null,
        rateLimited: false,
        retryAfterHeader: null,
        stopCode: null,
        transportError: null,
      };
    }

    if (res.status === 429) {
      let header: string | null = null;
      try {
        header = res.headers?.get?.("retry-after") ?? null;
      } catch {
        header = null;
      }
      let code = "HTTP 429";
      try {
        code = pushRefusalCode(res.status, await res.json());
      } catch {
        /* bodyless 429 keeps the status-shaped code */
      }
      return {
        taskResults: [],
        wholeChunkRefusal: null,
        rateLimited: true,
        retryAfterHeader: header,
        stopCode: code,
        transportError: null,
      };
    }
    if (res.status >= 500 && attempt < IMPORT_CHUNK_MAX_ATTEMPTS) {
      try {
        await res.json().catch(() => null);
      } catch {
        /* drain best-effort */
      }
      await sleep(IMPORT_CHUNK_RETRY_DELAY_MS * attempt);
      continue;
    }
    let errorBody: unknown = null;
    try {
      errorBody = await res.json();
    } catch {
      errorBody = null;
    }
    return {
      taskResults: [],
      wholeChunkRefusal: { status: res.status, code: pushRefusalCode(res.status, errorBody) },
      rateLimited: false,
      retryAfterHeader: null,
      stopCode: null,
      transportError: null,
    };
  }
  throw new Error("unreachable: postImportChunk retry loop fell through");
}

/**
 * Chunked tree-import loop (ticket bulk-429) — returns the EXACT
 * `PushLoopResult` shape the task loops return (plus import file/link
 * tallies), so `push.ts` renders one summary for every path.
 *
 * Checkpoint/resume: after every chunk (and on early stop / before a
 * transport throw escapes) `{ order, attempted, idMap }` hits disk. A
 * rerun with an EXACT order match resumes at `attempted`. Refusal
 * grouping mirrors dec52322; only 402/429 stop the push. Files and links
 * never stop it: their failures are counted (with details) and the push
 * continues loudly — the task they belong to was still created.
 */
export async function importBatchTree(
  apiUrl: string,
  token: string,
  boardId: string | undefined,
  inputs: ImportTaskInput[],
  opts: ImportBatchOptions = {},
): Promise<ImportLoopResult> {
  const ordered = topoOrderImportTasks(inputs);
  const chunkSize = Math.min(
    IMPORT_MAX_TASKS,
    typeof opts.preflight?.maxTasks === "number" &&
      Number.isInteger(opts.preflight.maxTasks) &&
      opts.preflight.maxTasks >= 1
      ? opts.preflight.maxTasks
      : IMPORT_MAX_TASKS,
  );
  const maxFiles =
    typeof opts.preflight?.maxFiles === "number" &&
    Number.isInteger(opts.preflight.maxFiles) &&
    opts.preflight.maxFiles >= 1
      ? opts.preflight.maxFiles
      : IMPORT_MAX_FILES;
  const maxBytes =
    typeof opts.preflight?.maxBytes === "number" &&
    Number.isInteger(opts.preflight.maxBytes) &&
    opts.preflight.maxBytes >= 1
      ? opts.preflight.maxBytes
      : IMPORT_MAX_BYTES;
  const maxFileBytes =
    opts.maxFileBytes !== undefined
      ? opts.maxFileBytes
      : (opts.preflight?.maxFileBytes ?? null);
  // Per-task atomicity: tasks that cannot fully fit are skipped WHOLE
  // before chunk one — they never enter the order, the checkpoint, or
  // the idMap, so the next run re-attempts them.
  const { pushable, skipped: skippedTasks } = partitionImportInputs(ordered, {
    maxTasks: chunkSize,
    maxFiles,
    maxBytes,
    maxFileBytes,
  });
  const order = pushable.map((t) => t.localId);

  let base = 0;
  const idMap: Record<string, string> = {};
  if (opts.projectDir !== undefined) {
    const existing = readBatchCheckpoint(opts.projectDir);
    if (
      existing !== null &&
      existing.order.length === order.length &&
      existing.order.every((id, i) => id === order[i]) &&
      existing.attempted <= order.length
    ) {
      base = existing.attempted;
      Object.assign(idMap, existing.idMap);
    }
  }

  let imported = 0;
  let existingCount = 0;
  let skipped = 0;
  const groupOrder: string[] = [];
  const groups = new Map<string, PushRefusalGroup>();
  let stoppedEarly: PushLoopResult["stoppedEarly"] = null;
  let stopMessage: string | null = null;
  let retryAfter: string | null = null;
  let linksApplied = 0;
  let linksFailed = 0;
  const failedLinks: Array<{ clientId: string; reason: string }> = [];
  let filesUploaded = 0;
  let filesFailed = 0;
  let filesSkippedPresent = 0;
  const failedFiles: Array<{ clientId: string; name: string; reason: string }> = [];
  // 429 wait-resume budget (ticket bulk-429): every 429 wait in this push
  // spends from one per-push allowance of 3, then the push stops loudly.
  const maxResumes = opts.retry429?.maxResumes ?? PUSH_429_MAX_RESUMES;
  const sleep429 = opts.retry429?.sleepMs ?? sleep;
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

  const persist = (attempted: number): void => {
    if (opts.projectDir === undefined) return;
    writeBatchCheckpoint(opts.projectDir, {
      version: 1,
      order,
      attempted,
      idMap: { ...idMap },
    });
  };

  if (base > 0) opts.onProgress?.(base, order.length);

  // Chunk first, then drop the leading `base` tasks (resume): chunks are
  // fixed slices of the topo order, so a resume base lands on a chunk
  // boundary or slices one chunk (done prefix stays done, tail re-POSTs
  // smaller — per-task results still align 1:1 with the POSTed tasks).
  const allChunks = chunkImportTasks(pushable, chunkSize, maxFiles, maxBytes);
  const chunks: ImportChunk[] = [];
  {
    let done = 0;
    for (const c of allChunks) {
      if (done + c.tasks.length <= base) {
        done += c.tasks.length;
        continue;
      }
      if (done < base) {
        const sliceFrom = base - done;
        chunks.push({ tasks: c.tasks.slice(sliceFrom) });
        done = base;
      } else {
        chunks.push(c);
      }
    }
  }

  const pacingDelayMs = opts.pacingDelayMs ?? BATCH_CHUNK_PACING_DELAY_MS;
  const pacingSleep = opts.pacingSleepMs ?? sleep;
  let lastPostedChunk = -1;
  let processed = base;
  try {
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c]!;
      if (pacingDelayMs > 0 && lastPostedChunk !== -1 && c !== lastPostedChunk) {
        await pacingSleep(pacingDelayMs);
      }
      const outcome = await postImportChunk(apiUrl, token, boardId, chunk);
      lastPostedChunk = c;
      if (outcome.transportError !== null) {
        // Exhausted transport still throws (fails the push — the exact
        // one-by-one network-throw contract); progress persists first so
        // the rerun resumes after this chunk's boundary... the chunk was
        // never attempted, so persist the pre-chunk position.
        persist(processed);
        throw new Error(outcome.transportError);
      }
      if (outcome.rateLimited) {
        if (resumes < maxResumes) {
          resumes++;
          const waitMs = resolve429WaitMs(outcome.retryAfterHeader);
          opts.retry429?.onWait?.(waitMs, resumes);
          await sleep429(waitMs);
          c--;
          continue;
        }
        // Budget exhausted: every task in this chunk and every later
        // chunk is recorded as refused (429 group) — counts truthful,
        // nothing silently dropped — then stop loudly.
        const code = outcome.stopCode ?? "HTTP 429";
        for (let r = c; r < chunks.length; r++) {
          for (const t of chunks[r]!.tasks) {
            recordRefusal(429, code);
            for (const f of t.files) {
              filesFailed++;
              failedFiles.push({
                clientId: t.localId,
                name: f.name,
                reason: `rate-limited: resume budget exhausted (${code})`,
              });
            }
            processed++;
            opts.onProgress?.(processed, order.length);
          }
        }
        persist(processed);
        stoppedEarly = "rate-limited";
        stopMessage = code;
        retryAfter = outcome.retryAfterHeader;
        break;
      }
      if (outcome.wholeChunkRefusal !== null) {
        for (const t of chunk.tasks) {
          recordRefusal(outcome.wholeChunkRefusal.status, outcome.wholeChunkRefusal.code);
          for (const f of t.files) {
            filesFailed++;
            failedFiles.push({
              clientId: t.localId,
              name: f.name,
              reason: `HTTP ${outcome.wholeChunkRefusal!.status} ${outcome.wholeChunkRefusal!.code}`,
            });
          }
          processed++;
          opts.onProgress?.(processed, order.length);
        }
        persist(processed);
        continue;
      }
      for (let i = 0; i < chunk.tasks.length; i++) {
        const t = chunk.tasks[i]!;
        const r = outcome.taskResults[i]!;
        const clientId = t.localId;
        if (r.id !== undefined && typeof r.id === "string" && r.id.length > 0) {
          if (r.existing === true) existingCount++;
          else imported++;
          idMap[clientId] = r.id;
        } else if (r.error !== undefined) {
          const status = batchItemHttpStatus(r.error.code);
          const code = pushRefusalCode(status, {
            code: r.error.code,
            message: r.error.message,
          });
          recordRefusal(status, code);
          processed++;
          opts.onProgress?.(processed, order.length);
          if (status === 402 || status === 429) {
            for (let j = i + 1; j < chunk.tasks.length; j++) {
              recordRefusal(status, code);
              processed++;
              opts.onProgress?.(processed, order.length);
            }
            persist(processed);
            stoppedEarly = status === 402 ? "plan-limit" : "rate-limited";
            stopMessage = code;
            if (status === 429) retryAfter = outcome.retryAfterHeader;
            break;
          }
          continue;
        } else {
          recordRefusal(400, "BATCH_MISSING_RESULT");
          processed++;
          opts.onProgress?.(processed, order.length);
          continue;
        }
        // Per-file + per-link tallies (informational — never stop the push).
        if (Array.isArray(r.files)) {
          for (const fr of r.files) {
            if ("error" in fr) {
              filesFailed++;
              failedFiles.push({
                clientId,
                name: fr.name,
                reason: `${fr.error.code}: ${fr.error.message}`,
              });
            } else if ("skipped" in fr) {
              filesSkippedPresent++;
            } else {
              filesUploaded++;
            }
          }
        }
        if (Array.isArray(r.links)) {
          for (const lr of r.links) {
            if ("error" in lr) {
              linksFailed++;
              failedLinks.push({
                clientId,
                reason: `${lr.error.code}: ${lr.error.message}`,
              });
            } else {
              linksApplied++;
            }
          }
        }
        processed++;
        opts.onProgress?.(processed, order.length);
      }
      persist(processed);
      if (stoppedEarly !== null) break;
    }
  } catch (err) {
    persist(processed);
    throw err;
  }

  const attempted = processed;
  if (stoppedEarly === null && opts.projectDir !== undefined) {
    clearBatchCheckpoint(opts.projectDir);
  }
  // Deterministic failure order for --json/tests.
  failedFiles.sort(
    (a, b) => a.clientId.localeCompare(b.clientId) || a.name.localeCompare(b.name),
  );
  failedLinks.sort((a, b) => a.clientId.localeCompare(b.clientId));
  skippedTasks.sort((a, b) => a.localId.localeCompare(b.localId));
  return {
    imported,
    existing: existingCount,
    skipped,
    idMap,
    attempted,
    failures: groupOrder.map((k) => groups.get(k)!),
    stoppedEarly,
    stopMessage,
    retryAfter,
    linksApplied,
    linksFailed,
    failedLinks,
    filesUploaded,
    filesFailed,
    filesSkippedPresent,
    failedFiles,
    skippedTasks,
  };
}
