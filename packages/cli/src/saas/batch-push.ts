/**
 * Cloud batch-push client (ticket 8d3b2b81).
 *
 * WHAT: the batch counterpart to the one-by-one loop in `auth/login.ts`
 * (`createTasksOneByOne`) — probe → preflight → chunked `POST
 * /api/v0/tasks/batch` → checkpointed idMap → concurrent file uploads.
 * The server side landed separately (private b4332c9b + public contract
 * 65d08e5): at most V0_BATCH_MAX_ITEMS tasks per chunk, per-item
 * `[{ id } | { error: { code, message } }]` results in request order, and
 * `GET /api/v0/tasks/batch` as the preflight probe (tasks:read scope; a
 * 404 on old servers doubles as the capability probe).
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
import { PROTO_DIR } from "../core/types.js";
import { toV0CreateBody, pushRefusalCode, resolve429WaitMs, PUSH_429_MAX_RESUMES, type Push429ResumeOptions } from "../auth/login.js";
import type { PushLoopResult, PushRefusalGroup } from "../auth/login.js";
import { maybeCompressForUpload } from "./compression.js";

/**
 * Max tasks per `POST /api/v0/tasks/batch` (ticket 8d3b2b81).
 * WHAT: one named constant for the server's per-request cap — the chunker
 * below and the BATCH_TOO_LARGE guard share it, so the cap lives in
 * exactly one place.
 * WHY 100: the v0 contract fixes the cap at 100/chunk (`TaskBatchCreate`
 * `maxItems: 100`; over-cap answers 400 BATCH_TOO_LARGE). The effective
 * chunk size is `min(V0_BATCH_MAX_ITEMS, preflight.maxItems)` — a plan
 * may advertise a smaller window, never a larger one.
 */
export const V0_BATCH_MAX_ITEMS = 100;

/** Per-chunk POST bound (ticket 8d3b2b81): same 30s as the single-create
 * POST in `createTasksOneByOne` — a hung chunk must not stall a 1704-task
 * push forever. Exceeded → the attempt throws like a network error and
 * the retry policy below applies. */
export const BATCH_CHUNK_TIMEOUT_MS = 30_000;

/** Chunk retry budget (ticket 8d3b2b81): initial attempt + 2 retries.
 * WHAT: retries cover transport failures (throw/timeout) and 5xx only —
 * 4xx is a caller/auth story (no retry: 402/429 stop the push, other 4xx
 * degrade to grouped refusals for the chunk's items, mirroring the
 * one-by-one loop where a non-ok NEVER retries).
 * WHY 3 total: one retry is not enough to ride out a rolling restart;
 * unbounded retry on a 1704-task push could hammer a sick server for
 * hours. A 5xx that survives all 3 attempts degrades to grouped refusals
 * (push continues, loudly) — only a dead transport fails the push. */
export const BATCH_CHUNK_MAX_ATTEMPTS = 3;

/** Linear backoff between chunk retries: 500ms × attempt (ticket 8d3b2b81).
 * Small enough to keep a bulk push fast, large enough not to hot-loop a
 * recovering server. */
export const BATCH_CHUNK_RETRY_DELAY_MS = 500;

/** Capability-probe bound (ticket 8d3b2b81): one cheap GET — 15s, not
 * 30s, because the probe gates the whole push and must fail fast. */
export const BATCH_PROBE_TIMEOUT_MS = 15_000;

/** Bounded R2/file-upload concurrency (ticket 8d3b2b81).
 * WHAT: at most 4 in-flight file POSTs (and 4 in-flight presence GETs).
 * WHY 4: the legacy uploader was strictly sequential (1×) — 4× is a
 * meaningful speedup for screenshot-heavy pushes without opening 1704
 * sockets or tripping the cloud token-bucket (writes 60/min sustained;
 * bursts of 4 stay polite). One constant gates BOTH the presence-check
 * phase and the upload phase so R2 traffic has a single ceiling. */
export const BATCH_FILE_CONCURRENCY = 4;

/** Checkpoint file name (ticket 8d3b2b81): lives at
 * `<projectDir>/.vibeflow/push-batch.checkpoint.json` — next to, never
 * inside, `.vibeflow/tasks/`, so the task listing never picks it up as a
 * task and the post-push deletion (task files + asset dirs only) never
 * touches it; completion deletes it explicitly. */
export const BATCH_CHECKPOINT_FILENAME = "push-batch.checkpoint.json";

export function batchCheckpointPath(projectDir: string): string {
  return join(projectDir, PROTO_DIR, BATCH_CHECKPOINT_FILENAME);
}

/** Preflight envelope of `GET /api/v0/tasks/batch` (ticket 8d3b2b81):
 * remaining task capacity BEFORE chunk one. Limits (and remainings) are
 * null when the plan caps nothing on that dimension. */
export interface BatchPreflight {
  maxItems: number;
  plan: string;
  openLimit?: number | null;
  openUsed?: number;
  openRemaining?: number | null;
  totalLimit?: number | null;
  totalUsed?: number;
  totalRemaining?: number | null;
}

export type BatchProbeResult =
  | { supported: true; preflight: BatchPreflight }
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

/** Legacy-path spelling of the batch endpoint (ticket 8d3b2b81): every
 * cloud URL in this module goes through `surfacePath("cloud", …)` — the
 * single prefix table in `core/api-url.ts` — so `/api/cli/tasks/batch`
 * maps to `/api/v0/tasks/batch` exactly like `/api/cli/tasks` maps to
 * `/api/v0/tasks`. Old servers never had it → 404 → the probe's
 * unsupported branch. */
const BATCH_LEGACY_PATH = "/api/cli/tasks/batch";

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

function batchUrl(apiUrl: string): string {
  return `${requireHttpBase(apiUrl)}${surfacePath("cloud", BATCH_LEGACY_PATH)}`;
}

function authHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capability probe (ticket 8d3b2b81): `GET /api/v0/tasks/batch`.
 * - 200 WITH the preflight envelope → `{ supported: true, preflight }`.
 * - 200 WITHOUT the preflight envelope → `{ supported: false }` (LENIENT —
 *   an old server's router prefix-matches `/tasks/batch` onto the list
 *   handler and answers 200 `{ items, nextCursor }`; see below).
 * - 404 → `{ supported: false }` — an old server; the caller falls back
 *   to the one-by-one loop. The 404 body is never parsed (old servers
 *   answer HTML here; parsing it would throw a confusing SyntaxError).
 * - 401/403 → THROW (bad token must abort BEFORE any destructive step —
 *   falling back would "push" 0 tasks and the post-push deletion would
 *   still wipe locals).
 * - any other non-ok (incl. 5xx and non-legacy 400s) → THROW (unknown
 *   server state — abort loudly rather than blind-attempt a bulk push;
 *   the message carries the status). A 5xx proves nothing except outage:
 *   routed to fallback, every per-item POST would 500 → 0 imported, N
 *   refused, no throw → `push.ts` would still delete ALL locals. So a
 *   sick server aborts loudly, while a 200-that-answered (any shape)
 *   falls back — the fallback only ever runs when the server proved it
 *   can route and answer.
 * - transport throw/timeout → propagates (callers report it as a failed
 *   push, same as the one-by-one loop's network-throw contract).
 */
export async function probeBatchCapability(
  apiUrl: string,
  token: string,
): Promise<BatchProbeResult> {
  const res = await fetch(batchUrl(apiUrl), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(BATCH_PROBE_TIMEOUT_MS),
  });
  if (res.status === 404) return { supported: false };
  if (res.status === 400) {
    // Old-server alias artifact (ticket 8d3b2b81): the LOCAL board's v0
    // read-alias rewrites GET /api/v0/tasks/batch onto the legacy
    // `/api/tasks/:id` handler, which rejects the literal id "batch"
    // with 400 `{ error: "Invalid task id" }` — semantically the same
    // "no batch here" as a 404, so it falls back too. Any OTHER 400
    // (a real v0 validation carries `code`) still throws below.
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body?.error === "Invalid task id") return { supported: false };
    } catch {
      /* unparseable 400 → fall through to the loud throw */
    }
  }
  if (!res.ok) {
    throw new Error(
      `batch capability probe failed: HTTP ${res.status} (only 404 falls back to one-by-one; auth/transport failures abort the push)`,
    );
  }
  const body = (await res.json()) as Partial<BatchPreflight> & Record<string, unknown>;
  // Lenient 200 (ticket 8d3b2b81): a 200 WITHOUT the preflight envelope is
  // "unsupported", never a throw. WHY lenient strictly dominates: real
  // legacy routers prefix-match unknown sub-paths, so GET
  // /api/v0/tasks/batch lands on the list handler and answers 200
  // `{ items, nextCursor }` — plausible on actual old servers, not just
  // mocks (this exact shape bricked push: the fail-closed probe threw and
  // push exited non-zero). A throwing probe would brick push against such
  // servers, defeating the fallback's purpose. And no scenario exists
  // where throwing helps: if the server is new-but-drifted, the one-by-one
  // fallback is still correct (just slower); if old, fallback is correct.
  // (5xx/other-non-ok keep throwing — see the doc block above for why a
  // 500 must abort loudly instead of falling back.)
  if (typeof body?.maxItems !== "number" || typeof body?.plan !== "string") {
    return { supported: false };
  }
  return {
    supported: true,
    preflight: {
      maxItems: body.maxItems,
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
 * Quota preflight gate (ticket 8d3b2b81): refuse-or-confirm BEFORE chunk
 * one instead of discovering the cap mid-push.
 * WHAT: returns a refusal message when the push cannot fit in the
 * remaining capacity, else null.
 * WHY refuse-only (no interactive confirm): the login-time push runs
 * inside a readline flow AND the `push` command runs in scripts — a
 * prompt cannot work in both — and the dec52322 rule is "never start a
 * push that cannot succeed". The caller prints the message (exact
 * numbers, both dimensions) and aborts; the user frees quota or pushes
 * fewer tasks and re-runs. `null` limits/remaining = uncapped dimension.
 */
export function evaluateBatchPreflight(
  remaining: number,
  preflight: BatchPreflight,
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

/** Split push records into request-order chunks (ticket 8d3b2b81). Pure
 * helper — the loop below depends on it, unit tests pin [100,100,50]. */
export function chunkTaskRecords(
  tasks: Array<Record<string, unknown>>,
  maxItems: number,
): Array<Array<Record<string, unknown>>> {
  const size = Math.floor(maxItems) >= 1 ? Math.floor(maxItems) : V0_BATCH_MAX_ITEMS;
  const chunks: Array<Array<Record<string, unknown>>> = [];
  for (let i = 0; i < tasks.length; i += size) {
    chunks.push(tasks.slice(i, i + size));
  }
  return chunks;
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

export type BatchItemResult =
  | { id: string }
  | { error: { code: string; message: string } };

export interface ChunkPostOutcome {
  /** Per-item results in request order (whole-chunk refusals are fanned
   * out to one entry per item so grouping stays per-task). */
  results: BatchItemResult[];
  /** Whole-chunk non-ok (4xx/5xx-exhausted): every item refused alike. */
  wholeChunkRefusal: { status: number; code: string } | null;
  stoppedEarly: PushLoopResult["stoppedEarly"];
  stopMessage: string | null;
  retryAfter: string | null;
}

/**
 * POST one chunk with timeout + retry (ticket 8d3b2b81).
 * - Transport throw/timeout or 5xx → retry to BATCH_CHUNK_MAX_ATTEMPTS
 *   (linear 500ms × attempt backoff); a 5xx surviving all attempts
 *   degrades to a whole-chunk refusal (push continues, loudly) while an
 *   exhausted TRANSPORT still throws (fails the push — the exact
 *   one-by-one network-throw contract).
 * - 402/429 whole-chunk → early-stop marker (further chunks futile —
 *   the dec52322 rule, unchanged).
 * - Other 4xx (incl. BATCH_TOO_LARGE, which our chunker makes
 *   impossible) → whole-chunk refusal, no retry, push continues.
 * - 200 → per-item results passthrough (length/order guarded: a short
 *   envelope marks the missing tail refused, never misaligns the idMap).
 */
export async function postTaskChunk(
  apiUrl: string,
  token: string,
  boardId: string | undefined,
  items: Array<Record<string, unknown>>,
): Promise<ChunkPostOutcome> {
  const body: Record<string, unknown> = {
    items: items.map((t) => toV0CreateBody(t, undefined)),
  };
  if (boardId !== undefined) body.boardId = boardId;

  let lastThrow: unknown = null;
  for (let attempt = 1; attempt <= BATCH_CHUNK_MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(batchUrl(apiUrl), {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(BATCH_CHUNK_TIMEOUT_MS),
      });
    } catch (err) {
      lastThrow = err;
      if (attempt < BATCH_CHUNK_MAX_ATTEMPTS) {
        await sleep(BATCH_CHUNK_RETRY_DELAY_MS * attempt);
        continue;
      }
      throw err;
    }

    if (res.ok) {
      const envelope = (await res.json().catch(() => null)) as {
        results?: unknown;
      } | null;
      const raw = Array.isArray(envelope?.results) ? envelope!.results! : [];
      const results: BatchItemResult[] = items.map((_, i) => {
        const entry = raw[i] as
          | { id?: unknown; error?: unknown }
          | undefined;
        if (entry && typeof entry.id === "string" && entry.id.length > 0) {
          return { id: entry.id };
        }
        if (entry && typeof entry.error === "object" && entry.error !== null) {
          const e = entry.error as Record<string, unknown>;
          return {
            error: {
              code:
                typeof e.code === "string" && e.code.length > 0
                  ? e.code
                  : "BATCH_ITEM_ERROR",
              message:
                typeof e.message === "string" && e.message.length > 0
                  ? e.message
                  : "batch item refused",
            },
          };
        }
        // Contract breach (short/malformed envelope): refuse the item
        // loudly under its own code — never shift the idMap.
        return {
          error: {
            code: "BATCH_MISSING_RESULT",
            message: "server returned fewer results than items",
          },
        };
      });
      return {
        results,
        wholeChunkRefusal: null,
        stoppedEarly: null,
        stopMessage: null,
        retryAfter: null,
      };
    }

    const status = res.status;
    if (status === 402 || status === 429) {
      let errorBody: unknown = null;
      try {
        errorBody = await res.json();
      } catch {
        errorBody = null;
      }
      const code = pushRefusalCode(status, errorBody);
      let retryAfter: string | null = null;
      if (status === 429) {
        try {
          retryAfter = res.headers?.get?.("retry-after") ?? null;
        } catch {
          retryAfter = null;
        }
      }
      return {
        results: [],
        wholeChunkRefusal: { status, code },
        stoppedEarly: status === 402 ? "plan-limit" : "rate-limited",
        stopMessage: code,
        retryAfter,
      };
    }
    if (status >= 500 && attempt < BATCH_CHUNK_MAX_ATTEMPTS) {
      try {
        await res.json().catch(() => null);
      } catch {
        /* drain best-effort */
      }
      await sleep(BATCH_CHUNK_RETRY_DELAY_MS * attempt);
      continue;
    }
    let errorBody: unknown = null;
    try {
      errorBody = await res.json();
    } catch {
      errorBody = null;
    }
    return {
      results: [],
      wholeChunkRefusal: { status, code: pushRefusalCode(status, errorBody) },
      stoppedEarly: null,
      stopMessage: null,
      retryAfter: null,
    };
  }
  throw lastThrow;
}

export interface BatchPushOptions {
  /** k/N reporter (the e4049164 factory) — called per completed item
   * with ABSOLUTE counts (resume base included) over the FULL total. */
  onProgress?: (done: number, total: number) => void;
  /** Project dir for the checkpoint file. Omit ONLY when the caller has
   * no project dir (then resume is unavailable but the push still runs). */
  projectDir?: string;
  /** Preflight (chunk sizing + nothing else — the refuse gate lives in
   * `evaluateBatchPreflight`, called by push.ts BEFORE this runs). */
  preflight?: BatchPreflight;
  /** 429 wait-resume knobs (ticket 99cf6943): same shape and defaults as
   * the one-by-one loop — one shared per-push budget of 3 waits. Omit
   * for the defaults (3 resumes, real sleep, silent waits); callers pass
   * `onWait` to narrate the stall. */
  retry429?: Push429ResumeOptions;
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

function taskOrderIds(tasks: Array<Record<string, unknown>>): string[] {
  return tasks.map((t) =>
    typeof t.id === "string" ? t.id : "",
  );
}

/**
 * Chunked batch-create loop (ticket 8d3b2b81) — returns the EXACT
 * `PushLoopResult` shape the one-by-one loop returns, so `push.ts`
 * renders both paths through the same summary/stop/links/json code.
 *
 * Checkpoint/resume: after every chunk (and on early stop / before a
 * transport throw escapes) `{ order, attempted, idMap }` hits disk. A
 * rerun with an EXACT order match resumes at `attempted` (already-mapped
 * ids ride along); any order drift discards the checkpoint and starts
 * fresh — resuming against a reordered list would misalign the idMap and
 * corrupt the links phase. Refusal grouping mirrors dec52322
 * (status+code groups, first-seen order; only 402/429 stop the push).
 */
export async function createTasksInBatches(
  apiUrl: string,
  token: string,
  boardId: string | undefined,
  tasks: Array<Record<string, unknown>>,
  opts: BatchPushOptions = {},
): Promise<PushLoopResult> {
  const chunkSize = Math.min(
    V0_BATCH_MAX_ITEMS,
    typeof opts.preflight?.maxItems === "number" &&
      Number.isInteger(opts.preflight.maxItems) &&
      opts.preflight.maxItems >= 1
      ? opts.preflight.maxItems
      : V0_BATCH_MAX_ITEMS,
  );
  const order = taskOrderIds(tasks);

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
  let skipped = 0;
  const groupOrder: string[] = [];
  const groups = new Map<string, PushRefusalGroup>();
  let stoppedEarly: PushLoopResult["stoppedEarly"] = null;
  let stopMessage: string | null = null;
  let retryAfter: string | null = null;
  // 429 wait-resume budget (ticket 99cf6943): whole-chunk re-POSTs and
  // mid-chunk pauses below each spend one of 3 waits per push (shared
  // allowance with the one-by-one loop), then the push stops loudly.
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

  // Resume base counts as already-attempted for the k/N surface.
  if (base > 0) opts.onProgress?.(base, tasks.length);

  const chunks = chunkTaskRecords(tasks, chunkSize);
  let processed = base;
  try {
    // Chunks are fixed slices of the push order; on resume the leading
    // `base` items are already done — their chunks are skipped WITHOUT
    // re-POSTing. Checkpoint writes are chunk-aligned, so `base` always
    // lands on a chunk boundary.
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c]!;
      const chunkStart = c * chunkSize;
      // Fully-processed chunks are skipped WITHOUT re-POSTing. A resume
      // base that lands MID-chunk (early-stop persist) slices the chunk:
      // the done prefix stays done, the tail is POSTed as a smaller
      // chunk — per-item results still align 1:1 with the POSTed items.
      if (chunkStart + chunk.length <= base) continue;
      if (processed >= tasks.length) break;
      const items = chunkStart < base ? chunk.slice(base - chunkStart) : chunk;
      const outcome = await postTaskChunk(apiUrl, token, boardId, items);
      if (outcome.wholeChunkRefusal !== null) {
        // 429 with budget left (ticket 99cf6943): wait, then re-POST the
        // same chunk — the checkpoint still holds the pre-chunk position,
        // so nothing is recorded and nothing is lost (`c--`: a bare
        // `continue` would advance to the NEXT chunk and drop this one).
        // Any other whole-chunk refusal (or an exhausted budget) takes
        // the loud path below: record every item, persist, and stop on
        // 402/429.
        if (outcome.stoppedEarly === "rate-limited" && resumes < maxResumes) {
          resumes++;
          const waitMs = resolve429WaitMs(outcome.retryAfter);
          opts.retry429?.onWait?.(waitMs, resumes);
          await sleep429(waitMs);
          c--;
          continue;
        }
        for (let i = 0; i < items.length; i++) {
          recordRefusal(
            outcome.wholeChunkRefusal.status,
            outcome.wholeChunkRefusal.code,
          );
          processed++;
          opts.onProgress?.(processed, tasks.length);
        }
        persist(processed);
        if (outcome.stoppedEarly !== null) {
          stoppedEarly = outcome.stoppedEarly;
          stopMessage = outcome.stopMessage;
          retryAfter = outcome.retryAfter;
          break;
        }
        continue;
      }
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const localId = typeof item.id === "string" ? item.id : "";
        const result = outcome.results[i]!;
        if ("id" in result) {
          imported++;
          if (localId.length > 0) idMap[localId] = result.id;
        } else {
          const status = batchItemHttpStatus(result.error.code);
          const code = pushRefusalCode(status, {
            code: result.error.code,
            message: result.error.message,
          });
          recordRefusal(status, code);
          processed++;
          opts.onProgress?.(processed, tasks.length);
          if (status === 402 || status === 429) {
            // Per-item 429 with budget left (ticket 99cf6943): this item
            // WAS refused (counted above), then wait and continue with
            // the chunk's remaining items using their ACTUAL results — no
            // fan-out, no stop. The 200 envelope carries no Retry-After,
            // so the wait holds the 60s default.
            if (status === 429 && resumes < maxResumes) {
              resumes++;
              const waitMs = resolve429WaitMs(null);
              opts.retry429?.onWait?.(waitMs, resumes);
              await sleep429(waitMs);
              continue;
            }
            // Per-item quota/rate hit stops the PUSH but the chunk's
            // remaining items were still attempted (one POST) — count
            // them refused under the same group so attempted stays exact.
            for (let j = i + 1; j < items.length; j++) {
              recordRefusal(status, code);
              processed++;
              opts.onProgress?.(processed, tasks.length);
            }
            persist(processed);
            stoppedEarly = status === 402 ? "plan-limit" : "rate-limited";
            stopMessage = code;
            if (status === 429) retryAfter = outcome.retryAfter;
            break;
          }
          continue;
        }
        processed++;
        opts.onProgress?.(processed, tasks.length);
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

/** One file-upload job (ticket 8d3b2b81): same fields the legacy
 * sequential uploader in `commands/push.ts` collects. */
export interface BatchFileJob {
  remoteId: string;
  name: string;
  filePath: string;
  size: number;
  system: boolean;
}

export interface BatchUploadResult {
  uploaded: number;
  /** Already present remotely — skipped WITHOUT a POST. */
  skippedPresent: number;
  failed: number;
  failedFiles: Array<{ name: string; reason: string }>;
}

/** Bounded worker pool (ticket 8d3b2b81): at most `limit` invocations of
 * `fn` in flight; results align to input order. Shared by the
 * presence-check phase and the upload phase so R2 traffic has ONE
 * ceiling (BATCH_FILE_CONCURRENCY). */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function filesListUrl(apiUrl: string, remoteId: string): string {
  return `${requireHttpBase(apiUrl)}${surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(remoteId)}/files`)}`;
}

/** Remote file names for skip-if-present (ticket 8d3b2b81): `GET
 * /api/v0/tasks/{id}/files` answers `{ items: [{ name }] }` (FileList).
 * Tolerates the legacy `{ files: [...] }` shape and bare arrays; ANY
 * failure (404 unknown task, network, garbage) degrades to "unknown —
 * upload anyway" (fail-open: presence is an optimization, never a gate).
 * Bound like every other fetch here. */
export async function listRemoteFileNames(
  apiUrl: string,
  token: string,
  remoteId: string,
): Promise<Set<string>> {
  try {
    const res = await fetch(filesListUrl(apiUrl, remoteId), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(BATCH_CHUNK_TIMEOUT_MS),
    });
    if (!res.ok) return new Set();
    const body = (await res.json().catch(() => null)) as {
      items?: unknown;
      files?: unknown;
    } | unknown[] | null;
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as { items?: unknown })?.items)
        ? ((body as { items?: unknown }).items as unknown[])
        : Array.isArray((body as { files?: unknown })?.files)
          ? ((body as { files?: unknown }).files as unknown[])
          : [];
    const names = new Set<string>();
    for (const row of rows) {
      if (
        typeof row === "object" &&
        row !== null &&
        typeof (row as Record<string, unknown>).name === "string"
      ) {
        names.add((row as Record<string, unknown>).name as string);
      } else if (typeof row === "string") {
        names.add(row);
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Concurrent file upload with skip-if-present (ticket 8d3b2b81).
 * Phase 1: presence GET per distinct remote task (bounded) — jobs whose
 * name is already remote are skipped WITHOUT a POST (resume-safe: a
 * killed push re-run uploads only the missing tail).
 * Phase 2: remaining jobs POST (bounded) with the SAME wire format as
 * the legacy uploader (single-encode brotli via maybeCompressForUpload,
 * `x-filename` / `x-file-system` / `x-content-encoding` headers, plain
 * Uint8Array body) — the server cannot tell the two uploaders apart.
 * Progress stays SPARSE (start + done lines on stderr): per-file `\r`
 * bars would garble under concurrency.
 */
export async function uploadBatchFiles(
  apiUrl: string,
  token: string,
  jobs: BatchFileJob[],
): Promise<BatchUploadResult> {
  if (jobs.length === 0) {
    return { uploaded: 0, skippedPresent: 0, failed: 0, failedFiles: [] };
  }
  const remoteIds = [...new Set(jobs.map((j) => j.remoteId))];
  const presence = new Map<string, Set<string>>();
  await runWithConcurrency(
    remoteIds,
    BATCH_FILE_CONCURRENCY,
    async (remoteId) => {
      presence.set(remoteId, await listRemoteFileNames(apiUrl, token, remoteId));
    },
  );

  let skippedPresent = 0;
  const pending: BatchFileJob[] = [];
  for (const job of jobs) {
    if (presence.get(job.remoteId)?.has(job.name) === true) {
      skippedPresent++;
    } else {
      pending.push(job);
    }
  }

  let uploaded = 0;
  let failed = 0;
  const failedFiles: Array<{ name: string; reason: string }> = [];
  await runWithConcurrency(pending, BATCH_FILE_CONCURRENCY, async (job) => {
    try {
      const data = readFileSync(job.filePath);
      // Same single-encode wire format as the legacy uploader in
      // commands/push.ts (q5): eligible text travels brotli-compressed
      // with `x-content-encoding`, never plain `Content-Encoding`.
      const { bytes: payload, contentEncoding } = maybeCompressForUpload(
        job.name,
        data,
      );
      const res = await fetch(filesListUrl(apiUrl, job.remoteId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "x-filename": encodeURIComponent(job.name),
          ...(job.system ? { "x-file-system": "1" } : {}),
          ...(contentEncoding ? { "x-content-encoding": contentEncoding } : {}),
        },
        body: new Uint8Array(payload),
        signal: AbortSignal.timeout(BATCH_CHUNK_TIMEOUT_MS),
      });
      if (res.ok) {
        uploaded++;
      } else {
        failed++;
        failedFiles.push({ name: job.name, reason: `HTTP ${res.status}` });
      }
    } catch (err) {
      failed++;
      failedFiles.push({
        name: job.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });
  // Deterministic failure order for --json/tests: uploads complete out
  // of order under concurrency, so sort once at the end.
  failedFiles.sort((a, b) => a.name.localeCompare(b.name));
  return { uploaded, skippedPresent, failed, failedFiles };
}
