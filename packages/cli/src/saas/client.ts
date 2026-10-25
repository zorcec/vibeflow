/**
 * SaaS API client for CLI online mode.
 *
 * When the CLI has a valid token, these functions read/write tasks and
 * comments from the SaaS backend instead of local .proto/ files.
 */
import { resolveProjectAuth } from "../auth/project-auth.js";
import { scopeHeaderFor } from "../auth/board-scope.js";
import {
  fetchWithTimeout,
  isSaasRequestTimeout,
  parseFallback,
  SAAS_UPLOAD_TIMEOUT_MS,
} from "./request.js";
import { getApiUrl, surfacePath } from "../core/api-url.js";
import type { AgentClaimRequestType } from "@vibeflow-tools/api-core";

export type SaasResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        status?: number;
        /**
         * The request path that failed (e.g. `/api/v0/tasks`). Carried so
         * callers can name the actual failure (HTTP status + path, or the
         * transport message) instead of a catch-all "backend is down".
         */
        path?: string;
        /**
         * The backend's own refusal code when the HTTP body carried one
         * (v0 answers `{ error, code }`, e.g. INVALID_LINKS for a dangling
         * parent). Transport/auth failures leave this absent and callers
         * fall back to the mapped `code` (E_BACKEND_UNAVAILABLE, ...).
         */
        serverCode?: string;
        /**
         * First bytes of a response body that was NOT valid JSON (a proxy
         * 502 HTML page, an empty body, truncated bytes). Carried so the
         * presentation layer can name what the server actually sent —
         * status, path AND head — instead of a bare parse failure
         * (ticket 5094958f). Absent whenever the body parsed as JSON.
         */
        bodyHead?: string;
        /**
         * Deadline marker (ticket d13fa9f5): present when the request hit
         * the transport deadline instead of answering. The message already
         * names phase + redacted URL; this marker lets the presentation
         * layer say "timed out" instead of reusing the bare transport
         * wording reserved for refused connections.
         */
        timeout?: { phase: string; timeoutMs: number };
      };
    };

/** Map CLI status values to SaaS DB enum values. */
const CLI_TO_SAAS_STATUS: Record<string, string> = {
  backlog: "backlog",
  todo: "todo",
  "in-progress": "in_progress",
  review: "review",
  done: "done",
};

/** Map SaaS DB enum values back to CLI status values.
 *
 * The v0 contract speaks hyphenated statuses on the wire (`in-progress`)
 * while storage (and the deleted legacy surface) used snake_case
 * (`in_progress`) — both spellings must resolve, or every in-progress
 * task reads back as the `?? "todo"` fallback. */
const SAAS_TO_CLI_STATUS: Record<string, string> = {
  backlog: "backlog",
  todo: "todo",
  in_progress: "in-progress",
  "in-progress": "in-progress",
  review: "review",
  done: "done",
  cancelled: "done",
};

export function toCliStatus(saasStatus: string): string {
  return SAAS_TO_CLI_STATUS[saasStatus] ?? "todo";
}

export function toSaasStatus(cliStatus: string): string {
  return CLI_TO_SAAS_STATUS[cliStatus] ?? "todo";
}

export interface SaasComment {
  id: string;
  taskId: string;
  body: string;
  authorId: string;
  /** v0 contract author (user|agent), preserved verbatim (ledger L1). */
  author?: string;
  createdAt: string;
}

/**
 * Map one v0 contract Comment ({ id, author, text }) onto the CLI-internal
 * SaasComment. Rows without contract text are dropped (null) — a comment
 * with no text cannot render, and the list read stays best-effort.
 */
export function toSaasComment(
  row: Record<string, unknown>,
  taskId: string,
): SaasComment | null {
  if (typeof row.id !== "string" || typeof row.createdAt !== "string") {
    return null;
  }
  if (typeof row.text !== "string") return null;
  return {
    id: row.id,
    taskId,
    body: row.text,
    authorId: typeof row.authorId === "string" ? row.authorId : "",
    ...(typeof row.author === "string" ? { author: row.author } : {}),
    createdAt: row.createdAt,
  };
}

export interface SaasTask {
  id: string;
  title: string;
  description: string | null;
  annotatedElementText?: string | null;
  status: string;
  author?: string | null;
  priority: string | null;
  type: string | null;
  /**
   * Free-form tags the v0 wire sends on every row (`serializeV0Task`).
   * Present on list/detail/create reads; absent (or null) on older
   * shapes — callers read through the mapping, never this field.
   */
  tags?: string[] | null;
  boardId: string;
  createdAt: string;
  updatedAt: string;
  branchName?: string | null;
  /** Tri-state agent attestation: true/false = verdict, null/absent = not assessed. */
  verified?: boolean | null;
  /**
   * Parent/relates/blocks links as the v0 wire carries them
   * (`links: [{ taskId, type }]`). Present on reads; the online board CAN
   * express parent links, so the CLI-online list applies the same root-only
   * default the hosted MCP surface does.
   */
  links?: Array<{ taskId: string; type: string }>;
  /**
   * Detail-contract relations (ticket 086b40aa): GET /api/v0/tasks/:id answers
   * parentId + children alongside the task, so online --get renders relations
   * from the ONE detail response — never a board listing. Absent on older
   * servers — the CLI prints one 'relations unavailable' line, never nothing.
   */
  parentId?: string | null;
  children?: Array<{ id: string; title: string; status: string; type?: string }>;
  comments?: SaasComment[];
  /**
   * Server-computed counts the v0 list answers alongside each item.
   * Present on list reads; absent on older/legacy shapes — callers must
   * fall back to the hydrated array lengths when these are missing.
   */
  commentCount?: number;
  fileCount?: number;
  files?: Array<{
    name: string;
    size?: number;
    url?: string;
    content?: string;
    /** True when written by the engine. Round-trips through push/import. */
    system?: boolean;
  }>;
  /**
   * The ACCEPTED raw record the server stored. Present on create responses
   * from servers that advertise it: the verbatim `raw` (client body plus
   * backfilled id/links, sanitized — no merged column defaults). Absent on
   * older servers, in which case the response view is all there is.
   *
   * Online writes never touch the local store (owner decision): the local
   * copy comes from `pull`, and this field must not be passed on the MCP
   * wire.
   */
  record?: Record<string, unknown>;
}
/**
 * Project-scoped bearer headers (ADR-0005): the token AND the board
 * scope come from the given project's resolution. No projectDir means
 * no headers (fail-closed) — there are no ambient global reads.
 */
async function getBearerHeaders(
  projectDir?: string,
): Promise<Record<string, string> | null> {
  if (projectDir === undefined) return null;
  const auth = await resolveProjectAuth(projectDir);
  if (auth.mode !== "saas" || !auth.token) return null;
  // Every v0 request carries X-Vibeflow-Scope when a board is known
  // (ticket dabd2fb7): the server answers 422 SCOPE_REQUIRED to an
  // unscoped request on a multi-board account. The board is the
  // project's own pointer — the command entries (tasks/push) run
  // resolveBoardScope first, so auto-selection and the 2+ board refusal
  // happen before any request.
  return { Authorization: `Bearer ${auth.token}`, ...scopeHeaderFor(auth.workspaceId) };
}

/**
 * Upper bound on concurrent hydration requests. The default read path used
 * to `Promise.all` one hydration per task over the whole board (2+ requests
 * per task) — on a large board thousands of in-flight requests exhausted
 * sockets and the entire read failed even though the backend was healthy.
 * Hydration now runs through a worker pool of this size with strictly
 * sequential sub-requests inside each task, so in-flight requests never
 * exceed this bound no matter how large the board is.
 */
export const SAAS_HYDRATE_CONCURRENCY = 5;

/**
 * The v0 kanban ordering contract (ticket 05076246, private commit
 * afcb4a41): `?sort=kanban` pages the board in the client's listing order
 * (status rank, priority rank, created desc, id) so `limit` means "this
 * page, in that order". Mirrors the server's V0_TASK_KANBAN_ORDER — the
 * client never invents an ordering, it only asks for this named one.
 */
export const V0_TASK_KANBAN_ORDER: readonly string[] = [
  "status:asc",
  "priority:asc",
  "created:desc",
  "id:asc",
];

/** Accepted `?sort=` values for `GET /api/v0/tasks` (absent = createdAt DESC). */
export type V0TaskListSort = "kanban";

/**
 * Accepted `?scope=` values for `GET /api/v0/tasks` (ticket 05076246,
 * private LANE Z): `roots` restricts the page AND the total to root tasks
 * (the server image of the client's root-only filter — a task whose own
 * links carry no parent edge). Absent = every board row (unchanged).
 */
export type V0TaskListScope = "roots";

/**
 * Page size every `fetchSaasTasks` list request asks for (LANE Q step 1).
 *
 * The v0 list accepts `limit` 1–500 and defaults to 100 when the param is
 * absent (verified in the server's list route: `limit must be an integer
 * 1–500`, `V0_DEFAULT_LIST_LIMIT = 100`). The client used to send no
 * `limit` at all, so a 1,874-task board cost 19 default-sized pages per
 * listing; asking for the 500-row ceiling cuts that to 4 with the same
 * rows in the same order. Cursor-following is unchanged — a server that
 * ignores the param (older/local) simply answers its default pages and
 * the loop still reads to completion.
 */
export const SAAS_LIST_PAGE_SIZE = 500;

/**
 * Upper bound on v0 list pages per `fetchSaasTasks` read. The pages are
 * followed to completion (cursor until null) so a large board still reads
 * back whole — but a server that keeps answering a cursor forever would
 * spin the CLI forever, so a cursor that REMAINS at this cap FAILS the
 * read instead of returning a partial board. A partial board is the
 * dangerous outcome: prefix resolution and the delete child guard would
 * silently resolve against half the board (an older child reparented to a
 * newer task can fall outside any fixed window), so truncation is a loud
 * BOARD_TRUNCATED refusal, never a quiet short list.
 */
export const SAAS_LIST_MAX_PAGES = 500;

type TopKPage =
  | { ok: true; tasks: SaasTask[] }
  | { ok: false; fallbackToFullScan: true }
  | { ok: false; fallbackToFullScan: false; result: SaasResult<{ tasks: SaasTask[]; boardId: string }> };

/**
 * ONE-request kanban page for ticket 05076246: `GET <list>?sort=kanban
 * &limit=K` (+ optional `?status=` SET-narrowing, + optional `?scope=roots`,
 * + `?boardId=`). No cursor loop — the server's index-backed ordering IS
 * the page.
 *
 * Trust rule: the page is trusted ONLY when (a) the server echoes the kanban
 * order back (`order` deep-equals V0_TASK_KANBAN_ORDER) and (b) a requested
 * `scope=roots` leaves no parent edge in the page. An old server that
 * predates `?sort=` ignores the param and answers the default createdAt
 * order (or 400s INVALID_SORT), and an old server that predates `?scope=`
 * ignores it and answers peers including children — returning either as the
 * requested window would silently show the wrong rows, so all cases fall
 * back to the full scan (`fallbackToFullScan: true`) instead. Test fakes
 * that predate the `order` echo carry no `order` member and are trusted
 * as-is (the fake controls the row order it answers).
 */
async function fetchSaasTopKPage(
  headers: Record<string, string>,
  listPath: string,
  listRoute: string,
  boardId: string | undefined,
  opts: { status?: string; limit: number; scope?: V0TaskListScope },
): Promise<TopKPage> {
  // SAFETY: apiUrl is the validated SaaS base from getApiUrl() (same source
  // as every other fetch in this module) and listPath is the constant
  // surface-path mapping — no user input reaches the URL host.
  const apiUrl = getApiUrl();
  const url = new URL(`${apiUrl}${listPath}`);
  if (boardId) url.searchParams.set("boardId", boardId);
  url.searchParams.set("sort", "kanban");
  url.searchParams.set("limit", String(opts.limit));
  if (opts.status !== undefined && opts.status !== "") {
    url.searchParams.set("status", opts.status);
  }
  if (opts.scope === "roots") {
    url.searchParams.set("scope", "roots");
  }
  let res: Response;
  try {
    // pi-lens-ignore: ts-ssrf — url is getApiUrl() + constant surface path
    res = await fetchWithTimeout(url.toString(), { headers }, { phase: "board-resolution" });
  } catch (err) {
    return {
      ok: false,
      fallbackToFullScan: false,
      result: {
        ok: false,
        error: {
          code: "NETWORK_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      },
    };
  }
  if (!res.ok) {
    // INVALID_SORT (or any 400 on the versioned route) means the server
    // does not speak the kanban ordering — fall back to the full scan
    // rather than trusting a default-ordered page as the kanban window.
    // Any other HTTP failure (auth/scope/transport-shaped) still refuses.
    if (res.status === 400) return { ok: false, fallbackToFullScan: true };
    return {
      ok: false,
      fallbackToFullScan: false,
      result: {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: `HTTP ${res.status}`,
          status: res.status,
          path: listRoute,
        },
      },
    };
  }
  const data = (await res.json()) as {
    items?: SaasTask[];
    tasks?: SaasTask[];
    order?: unknown;
  };
  if (!Array.isArray(data.items) && !Array.isArray(data.tasks)) {
    return {
      ok: false,
      fallbackToFullScan: false,
      result: {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message:
            "Online board answered the kanban page without a task list — refusing rather than reading against a board that was never sent.",
          status: 200,
          path: listRoute,
        },
      },
    };
  }
  // Order echo check (see trust rule above): a present-but-foreign order
  // means the server ignored `?sort=kanban` — fall back, never wrong rows.
  if (Array.isArray(data.order)) {
    const echoed = data.order as unknown[];
    const matches =
      echoed.length === V0_TASK_KANBAN_ORDER.length &&
      echoed.every((v, i) => v === V0_TASK_KANBAN_ORDER[i]);
    if (!matches) return { ok: false, fallbackToFullScan: true };
  }
  const tasks = Array.isArray(data.items) ? data.items : (data.tasks as SaasTask[]);
  // Scope check for `?scope=roots` (ticket 05076246, LANE Z): an old server
  // that predates the scope param ignores it and answers peers — including
  // children. A child carries a parent-type edge on its OWN links (the
  // forward edge the client's isChildTask reads), so any such edge in the
  // page proves the scope was ignored and the page falls back to the full
  // scan rather than presenting children as roots. A scope-honouring server
  // never returns a parent edge here (ROOTS_ONLY_COND matches the client's
  // rule, dangling-insensitive), so the check is free of false positives.
  if (opts.scope === "roots") {
    const scopeLeaked = tasks.some(
      (t) =>
        Array.isArray((t as { links?: unknown }).links) &&
        ((t as { links: Array<{ type?: unknown }> }).links ?? []).some(
          (l) => typeof l === "object" && l !== null && (l as { type?: unknown }).type === "parent",
        ),
    );
    if (scopeLeaked) return { ok: false, fallbackToFullScan: true };
  }
  return { ok: true, tasks };
}

/**
 * Fetch tasks from the SaaS for the given board (or the user's default board).
 * Returns null if not authenticated or the request fails.
 *
 * Hydration is OPT-IN (`{ hydrate: true }`): the v0 list items already
 * carry `commentCount`/`fileCount`, which is all listings need. Passing
 * `hydrate: true` additionally fetches each task's comments + file list
 * (+ inlined text content for small `.md`/`.txt`, mirroring the legacy
 * list shape) — best-effort per task, never fatal, and bounded by
 * SAAS_HYDRATE_CONCURRENCY in flight.
 *
 * v0 envelope: `GET /api/v0/tasks` answers `{ items, nextCursor }` (NOT the
 * legacy `{ tasks, boardId }` the deleted `/api/cli/tasks` surface spoke).
 * Pages are followed via `?cursor=` until `nextCursor` is null so a large
 * board still reads back whole; every page asks for SAAS_LIST_PAGE_SIZE
 * rows (the server ceiling) so the whole costs ceil(N/500) requests.
 */
export async function fetchSaasTasks(
  boardId?: string,
  opts?: {
    hydrate?: boolean;
    status?: string;
    /**
     * `kanban` = the V0_TASK_KANBAN_ORDER contract above. Absent = the
     * historical `createdAt DESC` default. Only honoured together with a
     * positive `limit` (the top-K page); without a limit the read stays a
     * full scan so an unfiltered listing that does NOT request the kanban
     * sort keeps its historical row order and cost.
     */
    sort?: V0TaskListSort;
    /**
     * Top-K row cap for a `sort: "kanban"` page (1–500, the v0 ceiling).
     * Without `sort: "kanban"` this is ignored — a bare limit is NOT a
     * row cap (LANE Q step 2 rule: `status` narrows WHICH rows match, never
     * how many come back), so callers that need fewer rows without the
     * kanban sort keep paging to exhaustion and slicing client-side.
     */
    limit?: number;
    /**
     * `roots` = `?scope=roots` (page AND total restricted to root tasks).
     * Only honoured alongside `sort: "kanban"` + a positive `limit` (the
     * top-K page); without those it is ignored and the read stays a full
     * scan. The caller guarantees scope-match (see remote-task-store):
     * `roots` is offered only for the root-only listing, never for a
     * filtered search (which includes children by contract).
     */
    scope?: V0TaskListScope;
    /**
     * Project the request is scoped to (ADR-0005): token + board scope
     * come from this project's resolution. Absent → NOT_AUTHENTICATED
     * (fail-closed, never a global credential).
     */
    projectDir?: string;
  },
): Promise<SaasResult<{ tasks: SaasTask[]; boardId: string }>> {
  const headers = await getBearerHeaders(opts?.projectDir);
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  const apiUrl = getApiUrl();
  try {
    // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
    const listPath = surfacePath("cloud", "/api/cli/tasks");
    // The route (no query string) is reported on HTTP failures so the
    // message names the actual failure — status + path, not a catch-all.
    const listRoute = listPath.split("?")[0] as string;
    // Ticket 05076246 top-K page: `?sort=kanban&limit=K` (+ optional
    // `?scope=roots`) returns the first K rows in the client's listing order
    // in ONE request — no cursor loop. A bare `limit` without
    // `sort: "kanban"` is NOT a row cap (see the opts doc above); only the
    // two together take this branch. Anything else falls through to the
    // paged full scan below, which keeps its historical row order and cost.
    const topK =
      opts?.sort === "kanban" &&
      typeof opts?.limit === "number" &&
      Number.isInteger(opts.limit) &&
      (opts.limit as number) >= 1 &&
      (opts.limit as number) <= 500
        ? (opts.limit as number)
        : null;
    if (topK !== null) {
      const single = await fetchSaasTopKPage(headers, listPath, listRoute, boardId, {
        status: opts?.status,
        limit: topK,
        ...(opts?.scope === "roots" ? { scope: "roots" as const } : {}),
      });
      if (!single.ok) {
        // An old server that predates `?sort=kanban` answers 400
        // INVALID_SORT (or ignores the param and answers the default
        // createdAt order — detected via the `order` echo), and an old
        // server that predates `?scope=roots` ignores it and answers peers
        // (detected via a parent edge in the page). Either way the single
        // page cannot be trusted as the requested window, so fall through
        // to the full scan rather than returning wrong rows.
        // A genuinely failed read (auth/transport) still refuses here.
        if (single.fallbackToFullScan) {
          // fall through to the paged loop below (no sort, full scan)
        } else {
          return single.result;
        }
      } else {
        const tasks =
          opts?.hydrate === true
            ? await mapWithConcurrency(single.tasks, SAAS_HYDRATE_CONCURRENCY, (t) =>
                hydrateSaasTask(apiUrl, headers, t),
              )
            : single.tasks;
        return { ok: true, data: { tasks, boardId: boardId ?? "" } };
      }
    }
    const items: SaasTask[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let page = 0; page < SAAS_LIST_MAX_PAGES; page++) {
      const url = new URL(`${apiUrl}${listPath}`);
      if (boardId) url.searchParams.set("boardId", boardId);
      // Largest page the server supports (see SAAS_LIST_PAGE_SIZE): fewer
      // round trips for the same board, same rows in the same order.
      url.searchParams.set("limit", String(SAAS_LIST_PAGE_SIZE));
      // SET-narrowing only (LANE Q step 2): `status` restricts WHICH rows
      // match, never how many come back — the caller still pages to
      // exhaustion and sorts/limits client-side, so the answer is the same
      // set the unfiltered read would filter down to. Never a row cap.
      if (opts?.status !== undefined && opts.status !== "") {
        url.searchParams.set("status", opts.status);
      }
      if (cursor) url.searchParams.set("cursor", cursor);
      // pi-lens-ignore: ts-ssrf — url is getApiUrl() + constant surface path
      const res = await fetchWithTimeout(url.toString(), { headers }, { phase: "board-resolution" });
      if (!res.ok) {
        return {
          ok: false,
          error: {
            code: "HTTP_ERROR",
            message: `HTTP ${res.status}`,
            status: res.status,
            path: listRoute,
          },
        };
      }
      const data = (await res.json()) as {
        items?: SaasTask[];
        nextCursor?: string | null;
        // Legacy fallback: the deleted `/api/cli/tasks` surface (and test
        // fakes predating the cutover) answered `{ tasks, boardId }` with
        // comments/files already inlined.
        tasks?: SaasTask[];
      };
      // P2 (ticket d7b9dc13): a successful page that carries NEITHER `items`
      // NOR `tasks` is malformed, not empty — accepting `{}` as an empty
      // page would resolve reads against a board that was never sent.
      // P2 (ticket d7b9dc13): a successful page that carries NEITHER `items`
      // NOR `tasks` is malformed, not empty — accepting `{}` as an empty
      // page would resolve reads against a board that was never sent.
      if (!Array.isArray(data.items) && !Array.isArray(data.tasks)) {
        return {
          ok: false,
          error: {
            code: "HTTP_ERROR",
            message: `Online board answered page ${page + 1} without a task list — refusing rather than reading against a board that was never sent.`,
            status: 200,
            path: listRoute,
          },
        };
      }
      const pageItems = Array.isArray(data.items) ? data.items : (data.tasks as SaasTask[]);
      items.push(...pageItems);
      const next =
        typeof data.nextCursor === "string" && data.nextCursor.length > 0
          ? data.nextCursor
          : null;
      // P2: a cursor the server already answered is a loop, not progress —
      // fail now instead of burning the remaining page budget re-reading
      // the same window and then refusing at the cap anyway.
      if (next !== null && seenCursors.has(next)) {
        return {
          ok: false,
          error: {
            code: "BOARD_TRUNCATED",
            message: `Online board repeated the list cursor "${next}" — refusing a partial board rather than resolving against it.`,
            path: listRoute,
          },
        };
      }
      if (next !== null) seenCursors.add(next);
      cursor = next;
      if (!cursor) break;
    }
    // A cursor that survives the whole cap means the board did not fit:
    // report truncation instead of resolving against a partial board
    // (prefix resolution and the delete child guard would silently
    // resolve against half the board).
    if (cursor) {
      return {
        ok: false,
        error: {
          code: "BOARD_TRUNCATED",
          message: `Online board read hit the ${SAAS_LIST_MAX_PAGES}-page list cap with more pages remaining — refusing a partial board rather than resolving against it.`,
          path: listRoute,
        },
      };
    }
    // Hydration is explicit opt-in: a listing over a large board must cost
    // only the paginated list reads (the items already carry
    // commentCount/fileCount). When requested, a bounded worker pool caps
    // in-flight requests at SAAS_HYDRATE_CONCURRENCY — never `Promise.all`
    // over the whole board.
    const tasks =
      opts?.hydrate === true
        ? await mapWithConcurrency(items, SAAS_HYDRATE_CONCURRENCY, (t) =>
            hydrateSaasTask(apiUrl, headers, t),
          )
        : items;
    return { ok: true, data: { tasks, boardId: boardId ?? "" } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/** v0 file-list row shape (`GET /api/v0/tasks/:id/files` → `{ files }`). */
interface V0FileRow {
  name?: string;
  mimeType?: string | null;
  size?: number | null;
  system?: boolean;
  createdAt?: string;
  url?: string;
}

/** Legacy parity: only small text artifacts travelled with inlined content. */
const TEXT_INLINE_SIZE_LIMIT = 50_000;

function isInlineableText(name: string): boolean {
  return /\.(md|txt)$/i.test(name);
}

/**
 * Run `fn` over `items` with at most `limit` workers in flight — the
 * bounded replacement for `Promise.all(items.map(fn))`. Order is
 * preserved. A worker takes the next index synchronously between awaits,
 * so no two workers share an index.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results as R[];
}

/**
 * Best-effort per-task hydration: comments + files (+ text content) onto a
 * v0 list item. Anything missing/failed degrades to `[]`/absent content —
 * a hydration failure must never fail the whole list read. Items that
 * already carry the legacy inlined shape keep it (no refetch).
 *
 * Sub-requests run SEQUENTIALLY inside one task (comments, then files,
 * then each text download in turn): callers bound whole-board hydration
 * with a worker pool, and sequential interiors keep total in-flight
 * requests at or under that pool size no matter the file mix.
 */
async function hydrateSaasTask(
  apiUrl: string,
  headers: Record<string, string>,
  item: SaasTask,
): Promise<SaasTask> {
  const hasComments = Array.isArray(item.comments);
  const hasFiles = Array.isArray(item.files);
  if (hasComments && hasFiles) return item;
  const taskId = item.id;
  const base = surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(taskId)}`);
  const comments = hasComments
    ? (item.comments as SaasComment[])
    : await fetchV0Comments(apiUrl, headers, base, taskId);
  const files = hasFiles
    ? item.files
    : await fetchV0FilesWithContent(apiUrl, headers, base);
  return { ...item, comments, files };
}

async function fetchV0Comments(
  apiUrl: string,
  headers: Record<string, string>,
  taskBase: string,
  taskId: string,
): Promise<SaasComment[]> {
  try {
    // pi-lens-ignore: ts-ssrf — apiUrl is getApiUrl(), taskBase a constant path
    const res = await fetchWithTimeout(`${apiUrl}${taskBase}/comments`, { headers }, { phase: "board-resolution" });
    if (!res.ok) return [];
    const data = (await res.json()) as { comments?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.comments)) return [];
    // v0 comment rows carry no `taskId` — fill it so renderers keep working.
    const out: SaasComment[] = [];
    for (const row of data.comments) {
      if (typeof row !== "object" || row === null) continue;
      const mapped = toSaasComment(row, taskId);
      if (mapped) out.push(mapped);
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchV0FilesWithContent(
  apiUrl: string,
  headers: Record<string, string>,
  taskBase: string,
): Promise<SaasTask["files"]> {
  try {
    // pi-lens-ignore: ts-ssrf — apiUrl is getApiUrl(), taskBase a constant path
    const res = await fetchWithTimeout(`${apiUrl}${taskBase}/files`, { headers }, { phase: "board-resolution" });
    if (!res.ok) return [];
    const data = (await res.json()) as { files?: V0FileRow[] };
    const rows = Array.isArray(data.files) ? data.files : [];
    // Sequential text downloads: this helper runs inside the bounded
    // hydration pool, so parallel downloads here would multiply past the
    // pool cap (one slot per task must mean one request in flight).
    const out: NonNullable<SaasTask["files"]> = [];
    for (const f of rows) {
      if (typeof f.name !== "string" || f.name.length === 0) continue;
      const name = f.name;
      const rawUrl = typeof f.url === "string" ? f.url : undefined;
      const url =
        rawUrl !== undefined && /^https?:\/\//.test(rawUrl)
          ? rawUrl
          : rawUrl !== undefined
            ? `${apiUrl}${rawUrl}`
            : undefined;
      const size = typeof f.size === "number" ? f.size : undefined;
      let content: string | undefined;
      if (
        isInlineableText(name) &&
        url !== undefined &&
        size !== undefined &&
        size <= TEXT_INLINE_SIZE_LIMIT
      ) {
        content = await downloadTextFile(apiUrl, url, headers);
      }
      out.push({
        name,
        size,
        url,
        content,
        system: f.system === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function downloadTextFile(
  apiUrl: string,
  url: string,
  headers: Record<string, string>,
): Promise<string | undefined> {
  // SSRF guard: only ever download from the SaaS base the token belongs
  // to — the file URL is server-supplied (relative, absolutized above),
  // so anything off-origin is refused instead of fetched with a Bearer.
  if (!url.startsWith(apiUrl)) return undefined;
  try {
    // `identity` forces the plain-bytes branch server-side (no brotli
    // transfer framing to decode) — the bytes arrive as stored-plain.
    // pi-lens-ignore: ts-ssrf — guarded above: url must start with apiUrl
    const res = await fetchWithTimeout(url, {
      headers: { ...headers, "Accept-Encoding": "identity" },
    }, { phase: "board-resolution" });
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

/**
 * Fetch a single task from the SaaS by ID — exactly ONE detail request
 * (`GET /api/v0/tasks/:id`), never a whole-board listing. The returned
 * task still carries its comments/files: the single item is hydrated with
 * the same best-effort helper the (opt-in) board hydration uses.
 *
 * Failures name the actual failure: 404 answers `TASK_NOT_FOUND`, other
 * HTTP refusals carry status + path, and transport failures carry the
 * network message — never a catch-all.
 */
export async function fetchSaasTaskDetail(
  taskId: string,
  projectDir?: string,
): Promise<SaasResult<{ task: SaasTask }>> {
  const headers = await getBearerHeaders(projectDir);
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  const apiUrl = getApiUrl();
  // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
  const detailPath = surfacePath(
    "cloud",
    `/api/tasks/${encodeURIComponent(taskId)}`,
  );
  try {
    // pi-lens-ignore: ts-ssrf — apiUrl is getApiUrl(), detailPath a constant-mapped path
    const res = await fetchWithTimeout(`${apiUrl}${detailPath}`, { headers }, { phase: "board-resolution" });
    if (!res.ok) {
      if (res.status === 404) {
        return {
          ok: false,
          error: {
            code: "TASK_NOT_FOUND",
            message: `Task not found: ${taskId}`,
            status: 404,
            path: detailPath,
          },
        };
      }
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const serverMessage =
        typeof errBody.error === "string" ? errBody.error : undefined;
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: serverMessage ?? `HTTP ${res.status}`,
          status: res.status,
          path: detailPath,
          ...(typeof errBody.code === "string" && errBody.code
            ? { serverCode: errBody.code }
            : {}),
        },
      };
    }
    // v0 answers the bare task (contract Task).
    const item = (await res.json()) as SaasTask;
    const task = await hydrateSaasTask(apiUrl, headers, item);
    return { ok: true, data: { task } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * The online answer to a user-supplied id-like value, resolved against the
 * board listing the write goes to — the SaaS twin of the local
 * `resolveTaskId` rule (`matchesIdOrPrefix`): exact id wins first (an exact
 * id that is also a prefix of others still resolves to itself), then a
 * unique prefix, then refusal. Ambiguity and unknown values are refusals
 * with codes the CLI maps to exits — never a silent first-match, so a
 * link flag can never attach to a task the caller did not name.
 */
// ONE id rule — the implementation lives in `core/id-resolution.ts`
// (backend-neutral, dependency-free) so the file-backed ports share it
// without importing this HTTP client module. Re-exported here so every
// existing `saas/client.js` importer keeps resolving it unchanged.
export { resolveSaasTaskId } from "../core/id-resolution.js";
export type { SaasIdResolution } from "../core/id-resolution.js";

/**
 * Atomically claim the next actionable task on the online board (ticket
 * 6452504d, parent e7482da5): ONE versioned POST to
 * `POST /api/v0/tasks/claim-next` carrying the additive agent-claim body
 * (`agentVersion: 1` plus MCP-vocabulary filters). The SERVER owns
 * selection, ordering, ancestry/blocker policy and the status/assignee
 * guard — the client never lists, never filters, never PATCHes, so two
 * concurrent claimants cannot take the same task and a claim can never
 * report success when the remote refused.
 *
 * Truthfulness rules:
 * - an old server that does not know the versioned body (404/501/422, or a
 *   versioned `code` such as UNKNOWN_AGENT_VERSION) is a SPECIFIC refusal
 *   (`AGENT_VERSION_UNKNOWN`) — never a silent legacy fallback and never a
 *   list-then-PATCH, either of which would claim under the wrong policy.
 * - `dryRun: true` previews through the same endpoint: exactly this one
 *   request, no write, no PATCH follow-up.
 * - filters are sent VERBATIM (exact match, the local contract) — the old
 *   online case-folding of type/user is gone; the server applies the
 *   shared policy.
 */
export async function claimSaasTask(
  boardId: string | undefined,
  body: AgentClaimRequestType,
  projectDir?: string,
): Promise<
  SaasResult<{ task: SaasTask | null; warning?: string }>
> {
  const headers = await getBearerHeaders(projectDir);
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  const apiUrl = getApiUrl();
  // Cloud-only path: the single surface-path table maps this to the v0
  // claim route — no scattered path strings (see `surfacePath`).
  const claimPath = surfacePath("cloud", "/api/cli/tasks/claim-next");
  const url = new URL(`${apiUrl}${claimPath}`);
  if (boardId) url.searchParams.set("boardId", boardId);
  try {
    // pi-lens-ignore: ts-ssrf — url is getApiUrl() + constant claim path
    const res = await fetchWithTimeout(url.toString(), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, { phase: "POST (claim-next)" });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const serverCode =
        typeof errBody.code === "string" ? errBody.code : undefined;
      // An old server speaks no agent version: 404/501/422 on the
      // versioned route, or an explicit versioned refusal code. Specific
      // refusal — the caller must surface it, never work around it.
      if (
        res.status === 404 ||
        res.status === 501 ||
        res.status === 422 ||
        serverCode === "UNKNOWN_AGENT_VERSION" ||
        serverCode === "AGENT_VERSION_UNKNOWN"
      ) {
        return {
          ok: false,
          error: {
            code: "AGENT_VERSION_UNKNOWN",
            message:
              typeof errBody.error === "string" && errBody.error.length > 0
                ? errBody.error
                : "The board does not speak agent claim v1 — update the server before claiming remotely.",
            status: res.status,
            path: claimPath,
            ...(serverCode ? { serverCode } : {}),
          },
        };
      }
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message:
            typeof errBody.error === "string" && errBody.error.length > 0
              ? errBody.error
              : `HTTP ${res.status}`,
          status: res.status,
          path: claimPath,
          ...(serverCode ? { serverCode } : {}),
        },
      };
    }
    // Versioned success: `{ task }` with the claimed record, or
    // `{ task: null }` when no candidate was eligible — the same empty
    // success the local primitive reports as null, never an error.
    const data = (await res.json()) as {
      task?: SaasTask | null;
      warning?: string;
    };
    return {
      ok: true,
      data: { task: data.task ?? null, ...(data.warning ? { warning: data.warning } : {}) },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Fetch a single task from the SaaS by ID.
 * Returns null if not authenticated, not found, or the request fails.
 *
 * Single detail request (see fetchSaasTaskDetail) — never a board listing.
 */
export async function fetchSaasTask(taskId: string, projectDir?: string): Promise<SaasTask | null> {
  const result = await fetchSaasTaskDetail(taskId, projectDir);
  if (!result.ok) return null;
  return result.data.task;
}

/**
 * Update a task in the SaaS.
 * Returns the updated task or null on failure / not authenticated.
 */
export async function updateSaasTask(
  taskId: string,
  patch: {
    status?: string;
    title?: string;
    description?: string;
    priority?: string;
    branchName?: string;
    /** Tri-state attestation: true/false = verdict, null = clear to absent. */
    verified?: boolean | null;
    /**
     * Whole link set (v0 PATCH `links` replaces). The caller computes the
     * merge (set/replace/clear parent) from the task it read first — the
     * server validates (exists, not self, no cycle) and refuses INVALID_LINKS.
     */
    links?: Array<{ taskId: string; type: string }>;
  },
  projectDir?: string,
): Promise<SaasResult<{ task: SaasTask; warning?: string }>> {
  const headers = await getBearerHeaders(projectDir);
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  const body: Record<string, unknown> = {};
  if (patch.status !== undefined) body.status = toSaasStatus(patch.status);
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.priority !== undefined) body.priority = patch.priority;
  if (patch.branchName !== undefined) body.branchName = patch.branchName;
  // Send `null` explicitly to clear — undefined means "no change".
  if (patch.verified !== undefined) body.verified = patch.verified;
  if (patch.links !== undefined) body.links = patch.links;

  try {
    // pi-lens-ignore: ts-ssrf — getApiUrl() base + constant-mapped path
    const res = await fetchWithTimeout(
      // Cloud-only path: getApiUrl() is the SaaS base → always "cloud".
      `${getApiUrl()}${surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(taskId)}`)}`,
      {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { phase: "PATCH (task-update)" },
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const msg =
        typeof errBody.error === "string"
          ? errBody.error
          : `HTTP ${res.status}`;
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: msg,
          status: res.status,
          ...(typeof errBody.code === "string" && errBody.code
            ? { serverCode: errBody.code }
            : {}),
        },
      };
    }
    // v0 answers the bare task (contract Task) with an optional `warning`
    // alongside it on the already-claimed path — never a `{ task }` envelope.
    const data = (await res.json()) as SaasTask & { warning?: string };
    const { warning, ...task } = data;
    return { ok: true, data: { task, warning } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Delete a task from the SaaS by its FULL id (callers resolve prefixes
 * with `resolveSaasTaskId` first — this function never guesses). Exactly
 * one DELETE request (`DELETE /api/v0/tasks/:id`).
 *
 * The v0 DELETE CASCADES: the server deletes the task's whole descendant
 * cone and answers `{ success, deletedIds }` (root first). The caller
 * detects children beforehand from the board listing — not to refuse (the
 * server would delete them anyway), but to WARN explicitly that they go
 * with the parent — and reports the returned `deletedIds` so the outcome
 * is auditable. A 404 answers `TASK_NOT_FOUND` (deleted between the
 * listing read and this request); other HTTP refusals carry status + path,
 * and transport failures the network message. Fakes predating the cascade
 * answer `{}`/`{ success }` with no ids — that shape resolves to the
 * requested id alone, never to an empty set.
 */
export async function deleteSaasTask(
  taskId: string,
  projectDir?: string,
): Promise<SaasResult<{ id: string; deletedIds: string[] }>> {
  const headers = await getBearerHeaders(projectDir);
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  const apiUrl = getApiUrl();
  // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
  const deletePath = surfacePath(
    "cloud",
    `/api/cli/tasks/${encodeURIComponent(taskId)}`,
  );
  try {
    // pi-lens-ignore: ts-ssrf — apiUrl is getApiUrl(), deletePath a constant-mapped path
    const res = await fetchWithTimeout(`${apiUrl}${deletePath}`, {
      method: "DELETE",
      headers,
    }, { phase: "DELETE (task-delete)" });
    if (!res.ok) {
      if (res.status === 404) {
        return {
          ok: false,
          error: {
            code: "TASK_NOT_FOUND",
            message: `Task not found: ${taskId}`,
            status: 404,
            path: deletePath,
          },
        };
      }
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const serverMessage =
        typeof errBody.error === "string" ? errBody.error : undefined;
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: serverMessage ?? `HTTP ${res.status}`,
          status: res.status,
          path: deletePath,
          ...(typeof errBody.code === "string" && errBody.code
            ? { serverCode: errBody.code }
            : {}),
        },
      };
    }
    // Success-path body: a stalled body still wins as a timeout (ticket
    // d13fa9f5) — never a silent fallback to the requested id alone.
    const data = (await res.json().catch(parseFallback({}))) as {
      deletedIds?: unknown;
    };
    const deletedIds =
      Array.isArray(data.deletedIds) &&
      data.deletedIds.length > 0 &&
      data.deletedIds.every((d) => typeof d === "string")
        ? (data.deletedIds as string[])
        : [taskId];
    return { ok: true, data: { id: taskId, deletedIds } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * What the task-files endpoint answers for one stored file. The local
 * board answers `{ success, file: { name, size, url } }` and the cloud
 * answers `{ success, file: { id, name, sizeBytes, url, ... } }` — every
 * field but `name` is optional here so both shapes map onto one reader
 * instead of each caller re-deriving it.
 */
export interface SaasUploadedFile {
  /** Server file id when the backend mints one — otherwise the filename. */
  id: string;
  name: string;
  size: number;
  url?: string;
}

/**
 * Upload one file's bytes to a task in the SaaS (online attach). Exactly
 * one request: `POST /api/v0/tasks/:id/files` (the legacy
 * `/api/tasks/:id/files` spelling mapped through `surfacePath`) with a
 * multipart `file` field — the same contract the web kanban `uploadFile`
 * client speaks. The server mints a fresh file id per upload (it does NOT
 * dedupe by name), so callers check the file list first and never upload
 * the same (taskId, name) twice — one name, one row.
 *
 * Failures name the actual failure: 404 answers `TASK_NOT_FOUND`, other
 * HTTP refusals carry status + path, and transport failures carry the
 * network message.
 */
export async function uploadSaasFile(
  taskId: string,
  filename: string,
  data: Uint8Array,
  projectDir?: string,
): Promise<SaasResult<SaasUploadedFile>> {
  const headers = await getBearerHeaders(projectDir);
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  const apiUrl = getApiUrl();
  // Cloud-only path: apiUrl is the SaaS base → always "cloud".
  const uploadPath = surfacePath(
    "cloud",
    `/api/tasks/${encodeURIComponent(taskId)}/files`,
  );
  // Multipart `file` field, byte-for-byte the web kanban upload: the v0
  // route reads `formData.get("file")` (raw bodies need an `x-filename`
  // header instead, so multipart is the one spelling every server takes).
  // SAFETY: undici's FormData/Blob accept any ArrayBufferView at runtime;
  // the shared copy keeps the caller's buffer alive past the send.
  const shared = new Uint8Array(data.length);
  shared.set(data);
  const form = new FormData();
  form.append(
    "file",
    new Blob([shared], { type: "application/octet-stream" }),
    filename,
  );
  try {
    // pi-lens-ignore: ts-ssrf — apiUrl is getApiUrl(), uploadPath a constant-mapped path
    const res = await fetchWithTimeout(`${apiUrl}${uploadPath}`, {
      method: "POST",
      headers,
      body: form,
    }, { phase: "POST (file-upload)", timeoutMs: SAAS_UPLOAD_TIMEOUT_MS });
    if (!res.ok) {
      if (res.status === 404) {
        return {
          ok: false,
          error: {
            code: "TASK_NOT_FOUND",
            message: `Task not found: ${taskId}`,
            status: 404,
            path: uploadPath,
          },
        };
      }
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const serverMessage =
        typeof errBody.error === "string" ? errBody.error : undefined;
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: serverMessage ?? `HTTP ${res.status}`,
          status: res.status,
          path: uploadPath,
          ...(typeof errBody.code === "string" && errBody.code
            ? { serverCode: errBody.code }
            : {}),
        },
      };
    }
    // Success-path body: a stalled body still wins as a timeout (ticket
    // d13fa9f5) — never a silent fallback to filename/size guesses.
    const body = (await res.json().catch(parseFallback({}))) as Record<
      string,
      unknown
    >;
    // Local shape `{ success, file: { name, size } }`, cloud shape
    // `{ success, file: { id, name, sizeBytes, url } }` — read every
    // spelling in one place so the CLI never branches on the backend.
    const row =
      body.file && typeof body.file === "object"
        ? (body.file as Record<string, unknown>)
        : body;
    const name = typeof row.name === "string" ? row.name : filename;
    const size =
      typeof row.sizeBytes === "number"
        ? row.sizeBytes
        : typeof row.size === "number"
          ? row.size
          : data.length;
    const id =
      typeof row.id === "string"
        ? row.id
        : typeof body.id === "string"
          ? (body.id as string)
          : typeof body.fileId === "string"
            ? (body.fileId as string)
            : name;
    const url = typeof row.url === "string" ? row.url : undefined;
    return { ok: true, data: { id, name, size, ...(url ? { url } : {}) } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Add a comment to a task in the SaaS.
 * Returns the created comment or null on failure / not authenticated.
 */
export async function addSaasComment(
  taskId: string,
  body: string,
  projectDir?: string,
): Promise<SaasResult<SaasComment>> {
  const headers = await getBearerHeaders(projectDir);
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  try {
    // pi-lens-ignore: ts-ssrf — getApiUrl() base + constant-mapped path
    const res = await fetchWithTimeout(
      // Cloud-only path: getApiUrl() is the SaaS base → always "cloud".
      `${getApiUrl()}${surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(taskId)}/comments`)}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        // Contract CommentInput: `text` required, `author` preserved.
        // The CLI posts human-authored text; the server defaults author.
        body: JSON.stringify({ text: body }),
      },
      { phase: "POST (comment)" },
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const msg = (errBody.error as string) ?? `HTTP ${res.status}`;
      return {
        ok: false,
        error: { code: "HTTP_ERROR", message: msg, status: res.status },
      };
    }
    // v0 answers the bare contract Comment (status 200).
    const data = (await res.json()) as Record<string, unknown>;
    const mapped = toSaasComment(data, taskId);
    if (!mapped) {
      return {
        ok: false,
        error: { code: "HTTP_ERROR", message: "Malformed comment response" },
      };
    }
    return { ok: true, data: mapped };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Fetch comments for a task from the SaaS.
 * Returns null on failure / not authenticated.
 */
export async function fetchSaasComments(
  taskId: string,
  projectDir?: string,
): Promise<SaasComment[] | null> {
  const headers = await getBearerHeaders(projectDir);
  if (!headers) return null;

  try {
    // pi-lens-ignore: ts-ssrf — getApiUrl() base + constant-mapped path
    const res = await fetchWithTimeout(
      // Cloud-only path: getApiUrl() is the SaaS base → always "cloud".
      `${getApiUrl()}${surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(taskId)}/comments`)}`,
      { headers },
      { phase: "board-resolution" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { comments?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.comments)) return [];
    // v0 comment rows carry no `taskId` — fill it so renderers keep working.
    const out: SaasComment[] = [];
    for (const row of data.comments) {
      if (typeof row !== "object" || row === null) continue;
      const mapped = toSaasComment(row, taskId);
      if (mapped) out.push(mapped);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * First bytes of a response body kept for diagnosis (ticket 5094958f).
 * Long enough to distinguish `<html…` (proxy error page) from a
 * truncated `{"title…` or an empty body, short enough for a log line.
 */
export const NON_JSON_BODY_HEAD_CHARS = 200;

/** What `readResponseBody` recovers from one HTTP response. */
interface ParsedResponseBody {
  parsed?: Record<string, unknown>;
  /** Raw head when the body was not valid JSON (or the read failed). */
  bodyHead?: string;
  contentType?: string | null;
}

/**
 * Read a response as TEXT first, then interpret (ticket 5094958f).
 *
 * `res.json()` on a proxy 502 HTML page (or an empty/truncated body)
 * throws a bare SyntaxError that used to be swallowed into `{}` on the
 * error path — the create then reported a generic failure with the HTTP
 * status discarded — or escaped as NETWORK_ERROR on the success path,
 * mislabelling a server-shaped reply as "the network failed".
 * Text-first keeps the status AND the first bytes, so a future
 * occurrence names status, content-type and head on both paths.
 */
async function readResponseBody(res: Response): Promise<ParsedResponseBody> {
  const contentType =
    typeof res.headers?.get === "function"
      ? res.headers.get("content-type")
      : null;
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // A deadline while the body stalled still wins as a timeout — never
    // a swallowed empty read (ticket d13fa9f5). Parse failures keep the
    // old recovery below; only the deadline propagates.
    if (isSaasRequestTimeout(err)) throw err;
    return { contentType };
  }
  if (text.trim() === "") return { contentType };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return { parsed: parsed as Record<string, unknown>, contentType };
    }
    return { contentType };
  } catch {
    return {
      bodyHead: text.slice(0, NON_JSON_BODY_HEAD_CHARS),
      contentType,
    };
  }
}

/**
 * Create a new task in the SaaS.
 * Returns the created task or null on failure / not authenticated.
 */
export async function createSaasTask(params: {
  id?: string;
  title: string;
  description?: string;
  annotatedElementText?: string;
  status?: string;
  priority?: string;
  type?: string;
  boardId?: string;
  /**
   * Links to write with the new task (v0 POST `links`). A
   * `{ taskId, type: "parent" }` entry is the online spelling of the
   * local `--parent` flag — the server validates the target exists.
   */
  links?: Array<{ taskId: string; type: string }>;
  /**
   * Project the request is scoped to (ADR-0005): token + board scope
   * come from this project's resolution. Absent → NOT_AUTHENTICATED
   * (fail-closed, never a global credential).
   */
  projectDir?: string;
}): Promise<SaasResult<SaasTask>> {
  const headers = await getBearerHeaders(params.projectDir);
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  // The route (no query string) is reported on HTTP failures so the
  // message names the actual failure — status + path, not a catch-all.
  const createPath = surfacePath("cloud", "/api/cli/tasks");
  try {
    // Cloud-only path: getApiUrl() is the SaaS base → always "cloud".
    // pi-lens-ignore: ts-ssrf — getApiUrl() base + constant surface path
    const res = await fetchWithTimeout(`${getApiUrl()}${createPath}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }, { phase: "POST (task-create)" });
    if (!res.ok) {
      // The HTTP status is already known here: a deadline while reading
      // the error body falls back to the status-only refusal rather than
      // replacing it with a timeout (ticket d13fa9f5).
      const errBody = await readResponseBody(res).catch(
        parseFallback<ParsedResponseBody>({}),
      );
      const parsed = errBody.parsed ?? {};
      const msg =
        typeof parsed.error === "string"
          ? parsed.error
          : `HTTP ${res.status}`;
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: msg,
          status: res.status,
          path: createPath,
          ...(typeof parsed.code === "string" && parsed.code
            ? { serverCode: parsed.code }
            : {}),
          ...(errBody.bodyHead !== undefined
            ? { bodyHead: errBody.bodyHead }
            : {}),
        },
      };
    }
    // v0 answers the created task (contract Task), status 201 — newer
    // servers carry the accepted raw on an explicit `record` member alongside
    // the view (ticket 4efaa878: the clone persists that member verbatim).
    // Text-first (ticket 5094958f): a 201 with an unparseable body
    // (truncated/proxied bytes) is an HTTP-shaped failure — status + path
    // + head — never a bare SyntaxError escaping as NETWORK_ERROR.
    const raw = await readResponseBody(res);
    if (raw.parsed === undefined) {
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: `HTTP ${res.status}`,
          status: res.status,
          path: createPath,
          ...(raw.bodyHead !== undefined
            ? { bodyHead: raw.bodyHead }
            : {}),
        },
      };
    }
    // SAFETY: v0 answers the created task (contract Task) — parsed JSON body with the SaasTask shape.
    return { ok: true, data: raw.parsed as unknown as SaasTask };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
        // Deadline marker for the add renderer: timeout says "timed
        // out", refused connections keep the bare wording (ticket
        // d13fa9f5). Other mutations surface the phase via the message.
        ...(isSaasRequestTimeout(err)
          ? { timeout: { phase: err.phase, timeoutMs: err.timeoutMs } }
          : {}),
      },
    };
  }
}
