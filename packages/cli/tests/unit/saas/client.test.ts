import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("../../../src/auth/project-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/auth/project-auth.js")>();
  return { ...actual, resolveProjectAuth: vi.fn() };
});

import { resolveProjectAuth } from "../../../src/auth/project-auth.js";
import { saasAuth, localAuth } from "../helpers/mock-project-auth.js";

const PROJ = "/test-project";
import {
  toCliStatus,
  toSaasStatus,
  fetchSaasTasks,
  fetchSaasTaskDetail,
  SAAS_HYDRATE_CONCURRENCY,
  SAAS_LIST_MAX_PAGES,
  updateSaasTask,
  addSaasComment,
  fetchSaasComments,
  createSaasTask,
  deleteSaasTask,
  resolveSaasTaskId,
} from "../../../src/saas/client.js";

const SAMPLE_TASK = {
  id: "task-1",
  title: "Test Task",
  description: null,
  status: "todo",
  priority: null,
  type: null,
  boardId: "board-1",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

// v0 contract Comment row as the cloud answers it.
const V0_COMMENT = {
  id: "comment-1",
  author: "user",
  text: "Hello",
  createdAt: "2025-01-01T00:00:00Z",
};

// The CLI-internal shape the mapper produces (body + filled taskId).
const SAMPLE_COMMENT = {
  id: "comment-1",
  taskId: "task-1",
  body: "Hello",
  authorId: "",
  author: "user",
  createdAt: "2025-01-01T00:00:00Z",
};

function mockFetch(response: unknown, ok = true) {
  // The client reads bodies text-first (ticket 5094958f: a proxy 502 HTML
  // page must surface status + head, never a bare `res.json()` throw),
  // so the fake answers both spellings from the same payload.
  const text =
    typeof response === "string" ? response : JSON.stringify(response);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      headers: { get: () => "application/json" },
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(JSON.parse(text)),
    }),
  );
}

beforeEach(() => {
  vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VIBEFLOW_API_URL;
});

describe("toCliStatus", () => {
  it("maps known SaaS statuses to CLI equivalents", () => {
    expect(toCliStatus("backlog")).toBe("backlog");
    expect(toCliStatus("todo")).toBe("todo");
    expect(toCliStatus("in_progress")).toBe("in-progress");
    expect(toCliStatus("review")).toBe("review");
    expect(toCliStatus("done")).toBe("done");
  });

  // v0 speaks hyphenated statuses on the wire; the deleted legacy surface
  // spoke snake_case. Both must resolve — otherwise every in-progress task
  // reads back as the `?? "todo"` fallback.
  it("maps the v0 hyphenated in-progress spelling (not just snake_case)", () => {
    expect(toCliStatus("in-progress")).toBe("in-progress");
  });

  it("maps cancelled to done", () => {
    expect(toCliStatus("cancelled")).toBe("done");
  });

  it("defaults to todo for unknown statuses", () => {
    expect(toCliStatus("unknown-status")).toBe("todo");
    expect(toCliStatus("")).toBe("todo");
  });
});

describe("toSaasStatus", () => {
  it("maps known CLI statuses to SaaS DB enum values", () => {
    expect(toSaasStatus("backlog")).toBe("backlog");
    expect(toSaasStatus("todo")).toBe("todo");
    expect(toSaasStatus("in-progress")).toBe("in_progress");
    expect(toSaasStatus("review")).toBe("review");
    expect(toSaasStatus("done")).toBe("done");
  });

  it("defaults to todo for unknown CLI statuses", () => {
    expect(toSaasStatus("unknown")).toBe("todo");
    expect(toSaasStatus("")).toBe("todo");
  });
});

describe("fetchSaasTasks", () => {
  it("hydrates on explicit opt-in (the legacy comments/files shape)", async () => {
    mockFetch({ tasks: [SAMPLE_TASK], boardId: "board-1" });
    const result = await fetchSaasTasks(undefined,  { projectDir: "/test-project", hydrate: true });
    // The v0 read hydrates comments/files per task (best-effort `[]` when
    // the subpaths answer nothing shaped) — the legacy row keeps its fields.
    expect(result).toEqual({
      ok: true,
      data: {
        tasks: [{ ...SAMPLE_TASK, comments: [], files: [] }],
        boardId: "",
      },
    });
  });

  it("does NOT hydrate by default: one list request, zero per-task requests", async () => {
    const seen: string[] = [];
    const board = Array.from({ length: 6 }, (_, i) => ({
      ...SAMPLE_TASK,
      id: `task-${i}`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: board, nextCursor: null }),
        });
      }),
    );
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(true);
    // Exactly one paginated list read for the whole board…
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/api/v0/tasks");
    // …and no per-task comment/file hydration at all.
    expect(
      seen.some((u) => u.includes("/comments") || /\/files(\/|$)/.test(u)),
    ).toBe(false);
    if (!result.ok) return;
    expect(result.data.tasks).toEqual(board);
  });

  it("paginated listing costs one request per page and still zero per-task requests", async () => {
    const seen: string[] = [];
    const pages = [
      { items: [{ ...SAMPLE_TASK, id: "a" }], nextCursor: "cursor-1" },
      { items: [{ ...SAMPLE_TASK, id: "b" }], nextCursor: null },
    ];
    let pageIdx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        const page = pages[Math.min(pageIdx++, pages.length - 1)]!;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(page),
        });
      }),
    );
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    // Two pages → two list reads, no hydration fan-out.
    expect(seen).toHaveLength(2);
    expect(
      seen.some((u) => u.includes("/comments") || /\/files(\/|$)/.test(u)),
    ).toBe(false);
  });

  it("bounded hydration: in-flight per-task requests never exceed the pool cap", async () => {
    const board = Array.from({ length: 12 }, (_, i) => ({
      ...SAMPLE_TASK,
      id: `task-${i}`,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          // Yield so parallel workers actually overlap.
          await new Promise((r) => setTimeout(r, 5));
          if (url.endsWith("/comments"))
            return { ok: true, json: () => Promise.resolve({ comments: [] }) };
          if (url.endsWith("/files"))
            return { ok: true, json: () => Promise.resolve({ files: [] }) };
          return {
            ok: true,
            json: () => Promise.resolve({ items: board, nextCursor: null }),
          };
        } finally {
          inFlight--;
        }
      }),
    );
    const result = await fetchSaasTasks(undefined,  { projectDir: "/test-project", hydrate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks).toHaveLength(12);
    // Every task hydrated…
    for (const t of result.data.tasks) {
      expect(t.comments).toEqual([]);
      expect(t.files).toEqual([]);
    }
    // …without ever exceeding the concurrency bound (the list read is
    // sequential before hydration starts, so the max covers hydration).
    expect(maxInFlight).toBeLessThanOrEqual(SAAS_HYDRATE_CONCURRENCY);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("passes boardId query param when provided", async () => {
    mockFetch({ tasks: [], boardId: "b-2" });
    await fetchSaasTasks("b-2", { projectDir: "/test-project" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("boardId=b-2");
  });

  it("hits the v0 tasks list, never the deleted cloud legacy surface", async () => {
    mockFetch({ tasks: [], boardId: "b-1" });
    await fetchSaasTasks("b-1", { projectDir: "/test-project" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v0/tasks");
    expect((fetchCall[0] as string)).not.toContain("/api/cli/");
  });

  it("uses VIBEFLOW_API_URL env var when set", async () => {
    process.env.VIBEFLOW_API_URL = "http://custom-api:9000";
    mockFetch({ tasks: [], boardId: "b-x" });
    await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("custom-api:9000");
  });

  it("returns NOT_AUTHENTICATED when not authenticated", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(localAuth());
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result).toEqual({ ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } });
  });

  it("returns HTTP_ERROR when response is not ok", async () => {
    mockFetch(null, false);
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("HTTP_ERROR");
  });

  it("returns NETWORK_ERROR when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("sends Authorization header with Bearer token", async () => {
    mockFetch({ tasks: [], boardId: "b-1" });
    await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("uses default API URL when VIBEFLOW_API_URL is not set", async () => {
    delete process.env.VIBEFLOW_API_URL;
    mockFetch({ tasks: [], boardId: "b-1" });
    await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("https://app.vibeflow.tools");
  });
});

describe("fetchSaasTasks — largest page size (LANE Q step 1)", () => {
  /**
   * Fake honouring `limit` + offset `cursor` exactly like the v0 list:
   * no `limit` param answers the server default of 100, `limit` caps the
   * page, `nextCursor` is null exactly when the board is exhausted.
   */
  function mockPagedBoard(total: number) {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        const u = new URL(url);
        const rawLimit = u.searchParams.get("limit");
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        const offset = Number(u.searchParams.get("cursor") ?? "0");
        const ids = Array.from({ length: total }, (_, i) => `task-${i}`);
        const page = ids.slice(offset, offset + limit);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: page.map((id) => ({ ...SAMPLE_TASK, id })),
              nextCursor:
                offset + page.length < total
                  ? String(offset + page.length)
                  : null,
            }),
        });
      }),
    );
    return seen;
  }

  it("a 1,874-task board costs ceil(1874/500) = 4 requests, not 19", async () => {
    const seen = mockPagedBoard(1874);
    const result = await fetchSaasTasks("b-1", { projectDir: "/test-project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every page asks for the 500-row server ceiling…
    expect(seen).toHaveLength(4);
    for (const url of seen) {
      expect(new URL(url).searchParams.get("limit")).toBe("500");
    }
    // …and cursor-following still returns every row exactly once, in order.
    expect(result.data.tasks.map((t) => t.id)).toEqual(
      Array.from({ length: 1874 }, (_, i) => `task-${i}`),
    );
  });

  it("a small board costs exactly one request", async () => {
    const seen = mockPagedBoard(40);
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen).toHaveLength(1);
    expect(result.data.tasks).toHaveLength(40);
  });

  it("a board just over one page costs two requests", async () => {
    const seen = mockPagedBoard(501);
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen).toHaveLength(2);
    expect(result.data.tasks).toHaveLength(501);
  });
});

describe("fetchSaasTasks — status narrowing (LANE Q step 2)", () => {
  /**
   * Fake honouring `status` + `limit` + offset `cursor` like the v0 list:
   * an exact wire-status match narrows the set, pages cover the narrowed
   * set, `nextCursor` is null exactly when it is exhausted.
   */
  function mockFilteredBoard(statuses: string[]) {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        const u = new URL(url);
        const status = u.searchParams.get("status");
        const rawLimit = u.searchParams.get("limit");
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        const offset = Number(u.searchParams.get("cursor") ?? "0");
        const matching = statuses
          .map((s, i) => ({ id: `task-${i}`, status: s }))
          .filter((t) => status === null || t.status === status);
        const page = matching.slice(offset, offset + limit);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: page.map((t) => ({
                ...SAMPLE_TASK,
                id: t.id,
                status: t.status,
              })),
              nextCursor:
                offset + page.length < matching.length
                  ? String(offset + page.length)
                  : null,
            }),
        });
      }),
    );
    return seen;
  }

  it("a status-narrowed set pages to exhaustion with the param on every page", async () => {
    // 650 tasks, 500 of them todo: the narrowed read costs ONE page.
    const statuses = Array.from({ length: 650 }, (_, i) =>
      i < 500 ? "todo" : "review",
    );
    const seen = mockFilteredBoard(statuses);
    const result = await fetchSaasTasks("b-1",  { projectDir: "/test-project", status: "todo" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen).toHaveLength(1);
    for (const url of seen) {
      expect(new URL(url).searchParams.get("status")).toBe("todo");
    }
    expect(result.data.tasks).toHaveLength(500);
    expect(
      result.data.tasks.every((t) => t.status === "todo"),
    ).toBe(true);
  });

  it("an unfiltered read sends no status param", async () => {
    const seen = mockFilteredBoard(["todo", "review"]);
    const result = await fetchSaasTasks("b-1", { projectDir: "/test-project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const url of seen) {
      expect(new URL(url).searchParams.has("status")).toBe(false);
    }
    expect(result.data.tasks).toHaveLength(2);
  });
});

describe("updateSaasTask", () => {
  it("returns updated task on success", async () => {
    mockFetch(SAMPLE_TASK);
    const result = await updateSaasTask("task-1", { status: "in-progress" }, "/test-project");
    expect(result).toEqual({ ok: true, data: { task: SAMPLE_TASK, warning: undefined } });
  });

  it("maps CLI status to SaaS status in request body", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { status: "in-progress" }, "/test-project");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.status).toBe("in_progress");
  });

  it("returns warning when server provides one", async () => {
    mockFetch({ ...SAMPLE_TASK, warning: "Task is already in-progress by another user" });
    const result = await updateSaasTask("task-1", { status: "in-progress" }, "/test-project");
    expect(result).toEqual({ ok: true, data: { task: SAMPLE_TASK, warning: "Task is already in-progress by another user" } });
  });

  it("returns NOT_AUTHENTICATED when not authenticated", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(localAuth());
    const result = await updateSaasTask("task-1", {}, "/test-project");
    expect(result).toEqual({ ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } });
  });

  it("returns error when response is not ok", async () => {
    mockFetch(null, false);
    const result = await updateSaasTask("task-1", { title: "New Title" }, "/test-project");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["HTTP_ERROR", "NETWORK_ERROR"]).toContain(result.error.code);
  });

  it("returns NETWORK_ERROR when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await updateSaasTask("task-1", {}, "/test-project");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("sends Authorization header with Bearer token", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { status: "in-progress" }, "/test-project");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("sends PATCH request to correct URL", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { status: "in-progress" }, "/test-project");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v0/tasks/task-1");
    expect((fetchCall[1] as RequestInit).method).toBe("PATCH");
  });

  it("never hits the deleted cloud legacy surface", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { status: "todo" }, "/test-project");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).not.toContain("/api/cli/");
  });

  it("sends Content-Type header with JSON body", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { status: "in-progress" }, "/test-project");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends verified:true in the PATCH body", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { verified: true }, "/test-project");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.verified).toBe(true);
  });

  it("sends verified:false as a real verdict", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { verified: false }, "/test-project");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.verified).toBe(false);
  });

  it("sends verified:null to clear the verdict (not false)", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { verified: null }, "/test-project");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect("verified" in body).toBe(true);
    expect(body.verified).toBeNull();
    expect(body.verified).not.toBe(false);
  });

  it("omits verified when no verdict is supplied (leaves the server value untouched)", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { title: "New Title" }, "/test-project");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect("verified" in body).toBe(false);
  });

  it("sends links in the PATCH body (v0 replaces the whole set)", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", {
      links: [
        { taskId: "rel-1", type: "relates" },
        { taskId: "parent-2", type: "parent" },
      ],
    }, "/test-project");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.links).toEqual([
      { taskId: "rel-1", type: "relates" },
      { taskId: "parent-2", type: "parent" },
    ]);
  });

  it("carries the server refusal code through as serverCode", async () => {
    mockFetch({ error: "parent link would create a cycle", code: "INVALID_LINKS" }, false);
    const result = await updateSaasTask("task-1", {
      links: [{ taskId: "task-1", type: "parent" }],
    }, "/test-project");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HTTP_ERROR");
      expect(result.error.serverCode).toBe("INVALID_LINKS");
    }
  });
});

describe("fetchSaasTasks — v0 envelope", () => {
  const V0_ITEM = {
    id: "ext-1",
    externalId: "ext-1",
    cloudId: "cloud-1",
    title: "V0 task",
    description: "desc",
    status: "in-progress",
    priority: null,
    type: null,
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    commentCount: 0,
    fileCount: 0,
  };

  /** URL-routed fake: list → `{ items, nextCursor }`, subpaths → edge data. */
  function mockV0(opts: {
    pages?: Array<{ items: unknown[]; nextCursor: string | null }>;
    comments?: unknown[];
    files?: unknown[];
    fileText?: Record<string, string>;
    seen?: string[];
  }) {
    const seen: string[] = opts.seen ?? [];
    let pageIdx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        if (/\/api\/v0\/tasks\/[^/]+\/comments$/.test(url)) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ comments: opts.comments ?? [] }),
          });
        }
        if (/\/api\/v0\/tasks\/[^/]+\/files$/.test(url)) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ files: opts.files ?? [] }),
          });
        }
        if (/\/api\/v0\/tasks\/[^/]+\/files\//.test(url)) {
          const text = opts.fileText?.[url] ?? "";
          return Promise.resolve({ ok: true, text: () => Promise.resolve(text) });
        }
        const pages = opts.pages ?? [{ items: [V0_ITEM], nextCursor: null }];
        const page = pages[Math.min(pageIdx++, pages.length - 1)]!;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(page),
        });
      }),
    );
    return seen;
  }

  it("parses the v0 { items, nextCursor } envelope (not the legacy { tasks })", async () => {
    mockV0({});
    const result = await fetchSaasTasks(undefined,  { projectDir: "/test-project", hydrate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks).toHaveLength(1);
    expect(result.data.tasks[0]).toMatchObject({
      id: "ext-1",
      title: "V0 task",
      status: "in-progress",
    });
    // Hydration degrades to empty when the subpaths answer empty.
    expect(result.data.tasks[0]?.comments).toEqual([]);
    expect(result.data.tasks[0]?.files).toEqual([]);
  });

  it("follows nextCursor until the last page", async () => {
    const seen = mockV0({
      pages: [
        { items: [{ ...V0_ITEM, id: "a" }], nextCursor: "cursor-1" },
        { items: [{ ...V0_ITEM, id: "b" }], nextCursor: null },
      ],
    });
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(seen.some((u) => u.includes("cursor=cursor-1"))).toBe(true);
  });

  it("fails loudly instead of half-reading when pages never end (no silent page-cap stop)", async () => {
    // A cursor the server keeps answering forever: the read must refuse
    // with BOARD_TRUNCATED rather than returning the first window of
    // pages as if it were the whole board (that silent stop is what let a
    // child outside the window bypass the delete guard). P2 (ticket
    // d7b9dc13): a REPEATED cursor is a loop, so the read fails on the
    // second sight of it instead of burning the whole page budget first.
    const seen = mockV0({
      pages: [{ items: [{ ...V0_ITEM, id: "a" }], nextCursor: "cursor-forever" }],
    });
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("BOARD_TRUNCATED");
    expect(result.error.message).toContain("refusing a partial board");
    expect(result.error.message).toContain("repeated");
    expect(seen).toHaveLength(2);
  });

  it("refuses a page that carries neither items nor tasks ({} is malformed, not empty)", async () => {
    // P2 (ticket d7b9dc13): accepting `{}` as an empty page resolved reads
    // against a board that was never sent. One malformed page fails the
    // whole read instead.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: () => Promise.resolve("{}"),
        json: () => Promise.resolve({}),
      }),
    );
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HTTP_ERROR");
    expect(result.error.message).toContain("without a task list");
  });

  it("hydrates comments (filling the v0-missing taskId), file rows, and text content", async () => {
    const seen: string[] = [];
    mockV0({
      seen,
      comments: [
        { id: "c1", author: "agent", text: "note", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      files: [
        {
          name: "field-notes.md",
          mimeType: "text/markdown",
          size: 20,
          system: false,
          url: "/api/v0/tasks/ext-1/files/f1",
        },
      ],
      fileText: {
        "https://app.vibeflow.tools/api/v0/tasks/ext-1/files/f1":
          "field notes line one\n",
      },
    });
    const result = await fetchSaasTasks(undefined,  { projectDir: "/test-project", hydrate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = result.data.tasks[0]!;
    expect(task.comments).toEqual([
      {
        id: "c1",
        body: "note",
        authorId: "",
        author: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
        taskId: "ext-1",
      },
    ]);
    expect(task.files).toHaveLength(1);
    expect(task.files![0]).toMatchObject({
      name: "field-notes.md",
      size: 20,
      url: "https://app.vibeflow.tools/api/v0/tasks/ext-1/files/f1",
      content: "field notes line one\n",
      system: false,
    });
  });

  it("skips content download for binary attachments", async () => {
    const seen: string[] = [];
    mockV0({
      seen,
      files: [
        {
          name: "evidence.png",
          mimeType: "image/png",
          size: 70,
          url: "/api/v0/tasks/ext-1/files/f9",
        },
      ],
    });
    const result = await fetchSaasTasks(undefined,  { projectDir: "/test-project", hydrate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks[0]?.files).toMatchObject([{ name: "evidence.png" }]);
    expect(result.data.tasks[0]?.files![0]?.content).toBeUndefined();
    expect(seen.some((u) => u.endsWith("/files/f9"))).toBe(false);
  });

  it("tolerates the legacy { tasks } envelope (pre-cutover fakes)", async () => {
    mockFetch({ tasks: [SAMPLE_TASK], boardId: "board-1" });
    const result = await fetchSaasTasks(undefined,  { projectDir: "/test-project", hydrate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // SAMPLE_TASK carries no comments/files arrays, so hydration runs and
    // the tolerant single-response fake answers `{ tasks }` → `[]`.
    expect(result.data.tasks[0]?.comments).toEqual([]);
    expect(result.data.tasks[0]?.files).toEqual([]);
  });

  it("degrades a failed hydration to empty instead of failing the read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/comments") || url.includes("/files")) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [V0_ITEM], nextCursor: null }),
        });
      }),
    );
    const result = await fetchSaasTasks(undefined,  { projectDir: "/test-project", hydrate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks).toHaveLength(1);
    expect(result.data.tasks[0]?.comments).toEqual([]);
    expect(result.data.tasks[0]?.files).toEqual([]);
  });
});

describe("fetchSaasTasks — verified tri-state round-trip", () => {
  it("preserves verified:true and verified:false from the server", async () => {
    mockFetch({
      tasks: [
        { ...SAMPLE_TASK, id: "a", verified: true },
        { ...SAMPLE_TASK, id: "b", verified: false },
      ],
      boardId: "board-1",
    });
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.tasks.find((t) => t.id === "a")?.verified).toBe(true);
      expect(result.data.tasks.find((t) => t.id === "b")?.verified).toBe(false);
    }
  });

  // Absent stays absent on the wire — it must not arrive as false.
  it("preserves an absent verdict as null, never false", async () => {
    mockFetch({
      tasks: [
        { ...SAMPLE_TASK, id: "absent-null", verified: null },
        { ...SAMPLE_TASK, id: "absent-missing" },
      ],
      boardId: "board-1",
    });
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const byId = Object.fromEntries(result.data.tasks.map((t) => [t.id, t.verified]));
      expect(byId["absent-null"]).toBeNull();
      expect(byId["absent-null"]).not.toBe(false);
      expect(byId["absent-missing"]).toBeUndefined();
    }
  });
});

describe("fetchSaasTaskDetail — one request, never a board listing", () => {
  const DETAIL_TASK = {
    id: "ext-9",
    title: "Detail task",
    description: "desc",
    status: "todo",
    priority: null,
    type: null,
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    links: [{ taskId: "parent-1", type: "parent" }],
    commentCount: 1,
    fileCount: 0,
  };

  /** URL-routed fake: detail → bare task, subpaths → edges. */
  function mockDetail(seen: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        if (url.endsWith("/api/v0/tasks/ext-9")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(DETAIL_TASK),
          });
        }
        if (url.endsWith("/api/v0/tasks/ext-9/comments")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                comments: [
                  {
                    id: "c9",
                    author: "user",
                    text: "detail note",
                    createdAt: "2026-01-01T00:00:00.000Z",
                  },
                ],
              }),
          });
        }
        if (url.endsWith("/api/v0/tasks/ext-9/files")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ files: [] }),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: "not found" }),
        });
      }),
    );
  }

  it("issues one detail request (not a board listing) and hydrates that one task", async () => {
    const seen: string[] = [];
    mockDetail(seen);
    const result = await fetchSaasTaskDetail("ext-9", "/test-project");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exactly one request hits the detail route…
    const detailHits = seen.filter((u) =>
      u.endsWith("/api/v0/tasks/ext-9"),
    );
    expect(detailHits).toHaveLength(1);
    // …and nothing ever hits the bare list route.
    expect(
      seen.some((u) => /\/api\/v0\/tasks(\?|$)/.test(u)),
    ).toBe(false);
    // The one task still carries comments/files (links preserved too).
    expect(result.data.task).toMatchObject({
      id: "ext-9",
      title: "Detail task",
      links: [{ taskId: "parent-1", type: "parent" }],
    });
    expect(result.data.task.comments).toEqual([
      {
        id: "c9",
        body: "detail note",
        authorId: "",
        author: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        taskId: "ext-9",
      },
    ]);
    expect(result.data.task.files).toEqual([]);
  });

  it("404 answers TASK_NOT_FOUND with the status and the detail path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "not found" }),
      }),
    );
    const result = await fetchSaasTaskDetail("ghost", "/test-project");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TASK_NOT_FOUND");
    expect(result.error.status).toBe(404);
    expect(result.error.path).toContain("/api/v0/tasks/ghost");
    expect(result.error.message).toContain("ghost");
  });

  it("a 500 surfaces the status, the path, and the body message", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: "boom" }),
        });
      }),
    );
    const result = await fetchSaasTaskDetail("ext-9", "/test-project");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HTTP_ERROR");
    expect(result.error.status).toBe(500);
    expect(result.error.path).toContain("/api/v0/tasks/ext-9");
    expect(result.error.message).toContain("boom");
    expect(seen).toHaveLength(1);
  });

  it("a transport failure surfaces the network message, not a generic string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("socket hang up")),
    );
    const result = await fetchSaasTaskDetail("ext-9", "/test-project");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NETWORK_ERROR");
    expect(result.error.message).toContain("socket hang up");
  });
});

describe("fetchSaasTasks — failure reporting names the failure", () => {
  it("a 500 list read carries the status and the list path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "boom" }),
      }),
    );
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HTTP_ERROR");
    expect(result.error.status).toBe(500);
    expect(result.error.path).toContain("/api/v0/tasks");
  });

  it("a transport failure carries the network message verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch failed")),
    );
    const result = await fetchSaasTasks(undefined, { projectDir: "/test-project" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NETWORK_ERROR");
    expect(result.error.message).toBe("fetch failed");
  });
});

describe("addSaasComment", () => {
  it("returns created comment on success", async () => {
    mockFetch(V0_COMMENT);
    const result = await addSaasComment("task-1", "Hello", "/test-project");
    expect(result).toEqual({ ok: true, data: SAMPLE_COMMENT });
  });

  it("returns NOT_AUTHENTICATED when not authenticated", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(localAuth());
    const result = await addSaasComment("task-1", "Hello", "/test-project");
    expect(result).toEqual({ ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } });
  });

  it("returns error when response is not ok", async () => {
    mockFetch(null, false);
    const result = await addSaasComment("task-1", "Hello", "/test-project");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["HTTP_ERROR", "NETWORK_ERROR"]).toContain(result.error.code);
  });

  it("returns NETWORK_ERROR when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await addSaasComment("task-1", "Hello", "/test-project");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("sends POST request with Authorization header", async () => {
    mockFetch(V0_COMMENT);
    await addSaasComment("task-1", "Hello", "/test-project");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect((fetchCall[1] as RequestInit).method).toBe("POST");
  });

  it("sends comment body in JSON payload", async () => {
    mockFetch(V0_COMMENT);
    await addSaasComment("task-1", "Test comment", "/test-project");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
    expect(body.text).toBe("Test comment");
  });

  it("posts comments to the v0 path", async () => {
    mockFetch(V0_COMMENT);
    await addSaasComment("task-1", "Hello", "/test-project");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v0/tasks/task-1/comments");
  });
});

describe("fetchSaasComments", () => {
  it("returns comments on success", async () => {
    mockFetch({ comments: [V0_COMMENT] });
    const result = await fetchSaasComments("task-1", "/test-project");
    expect(result).toEqual([SAMPLE_COMMENT]);
  });

  it("returns null when not authenticated", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(localAuth());
    const result = await fetchSaasComments("task-1", "/test-project");
    expect(result).toBeNull();
  });

  it("returns null when response is not ok", async () => {
    mockFetch(null, false);
    const result = await fetchSaasComments("task-1", "/test-project");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await fetchSaasComments("task-1", "/test-project");
    expect(result).toBeNull();
  });

  it("sends GET request with Authorization header", async () => {
    mockFetch({ comments: [V0_COMMENT] });
    await fetchSaasComments("task-1", "/test-project");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("requests comments from correct URL", async () => {
    mockFetch({ comments: [V0_COMMENT] });
    await fetchSaasComments("task-1", "/test-project");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v0/tasks/task-1/comments");
  });

  // v0 comment rows carry no `taskId` — fill it so renderers keying on
  // `comment.taskId` keep working.
  it("fills taskId on v0 comment rows that omit it", async () => {
    mockFetch({
      comments: [
        { id: "c1", author: "agent", text: "x", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const result = await fetchSaasComments("task-9", "/test-project");
    expect(result).toEqual([
      {
        id: "c1",
        body: "x",
        authorId: "",
        author: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
        taskId: "task-9",
      },
    ]);
  });
});

describe("createSaasTask", () => {
  it("returns created task on success", async () => {
    mockFetch(SAMPLE_TASK);
    const result = await createSaasTask({ projectDir: "/test-project", title: "New Task" });
    expect(result).toEqual({ ok: true, data: SAMPLE_TASK });
  });

  it("returns NOT_AUTHENTICATED when not authenticated", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(localAuth());
    const result = await createSaasTask({ projectDir: "/test-project", title: "New Task" });
    expect(result).toEqual({ ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } });
  });

  it("returns error when response is not ok", async () => {
    mockFetch(null, false);
    const result = await createSaasTask({ projectDir: "/test-project", title: "New Task" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["HTTP_ERROR", "NETWORK_ERROR"]).toContain(result.error.code);
  });

  it("returns NETWORK_ERROR when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await createSaasTask({ projectDir: "/test-project", title: "New Task" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("sends POST request with Authorization header", async () => {
    mockFetch(SAMPLE_TASK);
    await createSaasTask({ projectDir: "/test-project", title: "New Task" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect((fetchCall[1] as RequestInit).method).toBe("POST");
  });

  it("sends task params in JSON body", async () => {
    mockFetch(SAMPLE_TASK);
    await createSaasTask({ projectDir: "/test-project", title: "Test Task", description: "Test desc" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
    expect(body.title).toBe("Test Task");
    expect(body.description).toBe("Test desc");
  });

  // Ticket c0557b6c: `projectDir` scopes the request (headers only). The
  // server mirrors the POST body verbatim as the stored `record`, so a
  // leaked key quarantines the row on every pull.
  it("never sends projectDir in the POST body", async () => {
    mockFetch(SAMPLE_TASK);
    await createSaasTask({ projectDir: "/test-project", title: "New Task" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
    expect("projectDir" in body).toBe(false);
    expect(body.title).toBe("New Task");
  });

  it("requests tasks from correct URL", async () => {
    mockFetch(SAMPLE_TASK);
    await createSaasTask({ projectDir: "/test-project", title: "New Task" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v0/tasks");
    expect((fetchCall[0] as string)).not.toContain("/api/cli/");
  });

  it("sends links in the POST body (the online spelling of --parent)", async () => {
    mockFetch(SAMPLE_TASK);
    await createSaasTask({ projectDir: "/test-project",
      title: "Child",
      links: [{ taskId: "parent-1", type: "parent" }],
    });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.links).toEqual([{ taskId: "parent-1", type: "parent" }]);
  });

  it("carries the server refusal code through as serverCode", async () => {
    mockFetch({ error: "Parent target task ghost not found", code: "INVALID_LINKS" }, false);
    const result = await createSaasTask({ projectDir: "/test-project",
      title: "Child",
      links: [{ taskId: "ghost", type: "parent" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HTTP_ERROR");
      expect(result.error.serverCode).toBe("INVALID_LINKS");
      expect(result.error.message).toBe("Parent target task ghost not found");
    }
  });

  it("leaves serverCode absent on transport failures", async () => {
    mockFetch(null, false);
    const result = await createSaasTask({ projectDir: "/test-project", title: "New Task" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.serverCode).toBeUndefined();
  });

  // Ticket 5094958f: a proxy 502 HTML page (or any non-JSON error body)
  // used to collapse into `{}` and a generic failure with the status
  // discarded. The error must name status + path + the body's head.
  it("names status, path and body head on a non-JSON error response", async () => {
    const html = "<html><body>Bad Gateway</body></html>";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        headers: { get: () => "text/html" },
        text: () => Promise.resolve(html),
        json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      }),
    );
    const result = await createSaasTask({ projectDir: "/test-project", title: "New Task" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HTTP_ERROR");
      expect(result.error.status).toBe(502);
      expect(result.error.path).toBe("/api/v0/tasks");
      expect(result.error.bodyHead).toBe(html);
      expect(result.error.serverCode).toBeUndefined();
    }
  });

  it("names an empty error body as HTTP status + path (no bare parse error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 413,
        headers: { get: () => "text/html" },
        text: () => Promise.resolve(""),
        json: () =>
          Promise.reject(new SyntaxError("Unexpected end of JSON input")),
      }),
    );
    const result = await createSaasTask({ projectDir: "/test-project", title: "New Task" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HTTP_ERROR");
      expect(result.error.status).toBe(413);
      expect(result.error.path).toBe("/api/v0/tasks");
      expect(result.error.message).toBe("HTTP 413");
      expect(result.error.bodyHead).toBeUndefined();
    }
  });

  it("reports a 201 with an unparseable body as HTTP_ERROR, not NETWORK_ERROR", async () => {
    const truncated = '{"id": "task-1", "title": "Test';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        headers: { get: () => "application/json" },
        text: () => Promise.resolve(truncated),
        json: () =>
          Promise.reject(
            new SyntaxError(
              "Unterminated string in JSON at position 30",
            ),
          ),
      }),
    );
    const result = await createSaasTask({ projectDir: "/test-project", title: "New Task" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HTTP_ERROR");
      expect(result.error.status).toBe(201);
      expect(result.error.path).toBe("/api/v0/tasks");
      expect(result.error.bodyHead).toBe(truncated);
    }
  });
});

describe("resolveSaasTaskId — online prefix resolution", () => {
  const board = [
    { id: "2e97853ea69e83aafefbfd3b0ebb63", title: "Parent" },
    // Extends the exact id above: the exact-id test proves the equality
    // arm wins even when a longer id starts with the whole exact id.
    {
      id: "2e97853ea69e83aafefbfd3b0ebb63de",
      title: "Extends the exact id",
    },
    { id: "2e97853e000000000000000000000001", title: "Sibling" },
    { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Other" },
  ];

  it("uses an exact id as-is, even when it prefixes others", () => {
    const resolved = resolveSaasTaskId(board, "2e97853ea69e83aafefbfd3b0ebb63");
    expect(resolved).toEqual({
      ok: true,
      id: "2e97853ea69e83aafefbfd3b0ebb63",
    });
  });

  it("resolves a unique prefix to the full id", () => {
    // "2e97853e00" prefixes only the sibling: every other board id
    // diverges at the ninth character, including the exact-id extender.
    const resolved = resolveSaasTaskId(board, "2e97853e00");
    expect(resolved).toEqual({
      ok: true,
      id: "2e97853e000000000000000000000001",
    });
  });

  it("refuses an ambiguous prefix, naming every candidate", () => {
    const resolved = resolveSaasTaskId(board, "2e97853e");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe("E_AMBIGUOUS");
      expect(resolved.message).toContain("2e97853ea69e83aafefbfd3b0ebb63");
      expect(resolved.message).toContain("2e97853e000000000000000000000001");
      expect(resolved.message).toContain("2e97853ea69e83aafefbfd3b0ebb63de");
      expect(resolved.candidates).toEqual([
        "2e97853ea69e83aafefbfd3b0ebb63",
        "2e97853ea69e83aafefbfd3b0ebb63de",
        "2e97853e000000000000000000000001",
      ]);
    }
  });

  it("refuses an unknown value with TASK_NOT_FOUND, naming the value", () => {
    const resolved = resolveSaasTaskId(board, "ghost");
    expect(resolved).toEqual({
      ok: false,
      code: "TASK_NOT_FOUND",
      message: "Task not found: ghost",
    });
  });

  it("refuses an empty value with TASK_NOT_FOUND (never matches everything)", () => {
    const resolved = resolveSaasTaskId(board, "");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe("TASK_NOT_FOUND");
  });
});

describe("resolveSaasTaskId — one id rule shared by every id-taking tasks flag", () => {
  // Ticket 7a4c48a5: `--edit`, `--get`, `--delete`, `--attach --task`,
  // `--commit --task`, `--parent`, `--set-parent`, `--relates`, `--blocks`,
  // `--unrelates` and `--unblocks` all resolve through this function, so
  // its contract is their contract. These tests ADD to the suite above;
  // none of its assertions are changed.
  const sharedBoard = [
    { id: "swy7ox61xtgk19uzw7uezzym", title: "Alpha" },
    { id: "swy7ox61xtgk19uzw7uezzym9q", title: "Alpha child" },
    { id: "swy7ox610000000000000001", title: "Sibling" },
  ];

  it("distinguishes 'no task matches' from 'several match'", () => {
    const missing = resolveSaasTaskId(sharedBoard, "ghost0000");
    expect(missing).toEqual({
      ok: false,
      code: "TASK_NOT_FOUND",
      message: "Task not found: ghost0000",
    });
    const crowded = resolveSaasTaskId(sharedBoard, "swy7ox61");
    expect(crowded.ok).toBe(false);
    if (!crowded.ok) {
      expect(crowded.code).toBe("E_AMBIGUOUS");
      // An ambiguous prefix must never read like a missing task.
      expect(crowded.message).not.toMatch(/not found/i);
      expect(crowded.message).toMatch(/Ambiguous task id prefix/);
    }
  });

  it("keeps the resolver's minimum: only the empty string is refused, any non-empty unique prefix resolves", () => {
    // No minimum length is introduced — a single character that names one
    // task resolves (exact behaviour of the pre-existing resolver).
    const divergentBoard = [
      { id: "aaa00000000000000000000001", title: "Aye" },
      { id: "bbb00000000000000000000001", title: "Bee" },
    ];
    expect(resolveSaasTaskId(divergentBoard, "a")).toEqual({
      ok: true,
      id: "aaa00000000000000000000001",
    });
  });
});

describe("deleteSaasTask", () => {
  function mockDelete(response: unknown, ok: boolean, status = 200) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok,
        status,
        json: () => Promise.resolve(response),
      }),
    );
  }

  it("sends one DELETE to the task path and resolves the id", async () => {
    mockDelete({}, true);
    const result = await deleteSaasTask("abc123", "/test-project");
    expect(result).toEqual({
      ok: true,
      data: { id: "abc123", deletedIds: ["abc123"] },
    });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[1] as RequestInit).method).toBe("DELETE");
    expect(fetchCall[0] as string).toContain("/api/v0/tasks/abc123");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });

  it("reports the server's deletedIds cone (cascade: root first, then descendants)", async () => {
    mockDelete({ success: true, deletedIds: ["p1", "c1", "g1"] }, true);
    const result = await deleteSaasTask("p1", "/test-project");
    expect(result).toEqual({
      ok: true,
      data: { id: "p1", deletedIds: ["p1", "c1", "g1"] },
    });
  });

  it("falls back to the requested id alone when the body carries no ids (pre-cascade fakes)", async () => {
    mockDelete({ success: true }, true);
    const result = await deleteSaasTask("abc123", "/test-project");
    expect(result).toEqual({
      ok: true,
      data: { id: "abc123", deletedIds: ["abc123"] },
    });
  });

  it("answers TASK_NOT_FOUND on a 404 (deleted between listing and request)", async () => {
    mockDelete({ error: "Task not found", code: "NOT_FOUND" }, false, 404);
    const result = await deleteSaasTask("gone", "/test-project");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_NOT_FOUND");
      expect(result.error.status).toBe(404);
    }
  });

  it("carries other HTTP refusals with status and path", async () => {
    mockDelete({ error: "Forbidden", code: "FORBIDDEN" }, false, 403);
    const result = await deleteSaasTask("abc123", "/test-project");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HTTP_ERROR");
      expect(result.error.status).toBe(403);
      expect(result.error.serverCode).toBe("FORBIDDEN");
      expect(result.error.message).toBe("Forbidden");
    }
  });

  it("answers NETWORK_ERROR when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("socket hang up")),
    );
    const result = await deleteSaasTask("abc123", "/test-project");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("answers NOT_AUTHENTICATED without a token and sends nothing", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(localAuth());
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const result = await deleteSaasTask("abc123", "/test-project");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_AUTHENTICATED");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("fetchSaasTasks — kanban top-K (ticket 05076246)", () => {
  const KANBAN_ORDER = ["status:asc", "priority:asc", "created:desc", "id:asc"];
  /**
   * Mixed board where kanban order DIFFERS from createdAt order by
   * construction: an old in-progress task outranks a new todo task under
   * kanban (status rank first) but sorts below it under createdAt desc.
   * The fake answers `?sort=kanban` slices in kanban order (with the `order`
   * echo) and plain pages in createdAt-desc order — so dropping the sort
   * param returns the WRONG row and the same-row test below goes red.
   */
  function kanbanBoard() {
    const rows = [
      { ...SAMPLE_TASK, id: "kanban-top", status: "in-progress", priority: "High", createdAt: "2026-01-01T00:00:00.000Z" },
      { ...SAMPLE_TASK, id: "second", status: "in-progress", priority: "Low", createdAt: "2026-02-01T00:00:00.000Z" },
      { ...SAMPLE_TASK, id: "third", status: "todo", priority: "Critical", createdAt: "2026-03-01T00:00:00.000Z" },
      // Newest by createdAt, but todo rank sits below in-progress — the
      // createdAt-first row that a sort-less top-K would wrongly return.
      { ...SAMPLE_TASK, id: "created-first", status: "todo", priority: "Medium", createdAt: "2026-09-01T00:00:00.000Z" },
    ];
    const kanbanOrder = rows.map((r) => r.id);
    const createdOrder = [...rows]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((r) => r.id);
    expect(kanbanOrder[0]).not.toBe(createdOrder[0]);
    return { rows, kanbanOrder, createdOrder };
  }
  function mockKanbanServer(all: Array<typeof SAMPLE_TASK>, seen: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        const u = new URL(url);
        const sort = u.searchParams.get("sort");
        const rawLimit = u.searchParams.get("limit");
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        const status = u.searchParams.get("status");
        const offset = Number(u.searchParams.get("cursor") ?? "0");
        if (sort === "kanban") {
          const narrowed = status === null ? all : all.filter((t) => t.status === status);
          const page = narrowed.slice(0, limit);
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ items: page, nextCursor: null, order: [...KANBAN_ORDER] }),
          });
        }
        // No sort: createdAt-desc pages (the historical default).
        const ordered = [...all].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        );
        const narrowed = status === null ? ordered : ordered.filter((t) => t.status === status);
        const page = narrowed.slice(offset, offset + limit);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: page,
              nextCursor:
                offset + page.length < narrowed.length
                  ? String(offset + page.length)
                  : null,
            }),
        });
      }),
    );
  }

  it("a top-K page is ONE request with sort=kanban&limit=K", async () => {
    const { rows } = kanbanBoard();
    const seen: string[] = [];
    mockKanbanServer(rows, seen);
    const result = await fetchSaasTasks("b-1",  { projectDir: "/test-project", sort: "kanban", limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen).toHaveLength(1);
    const u = new URL(seen[0] as string);
    expect(u.searchParams.get("sort")).toBe("kanban");
    expect(u.searchParams.get("limit")).toBe("1");
    expect(result.data.tasks.map((t) => t.id)).toEqual(["kanban-top"]);
  });

  it("the one-request row equals the full-scan client-sorted row (same-row)", async () => {
    const { rows } = kanbanBoard();
    // Full scan: no sort hint, pages to exhaustion in createdAt order.
    const seenFull: string[] = [];
    mockKanbanServer(rows, seenFull);
    const full = await fetchSaasTasks("b-1", { projectDir: "/test-project" });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    // Four rows fit in one default page — the point is the full scan carries
    // no sort param and returns createdAt order, while the top-K carries it.
    expect(seenFull.length).toBeGreaterThanOrEqual(1);
    for (const url of seenFull) {
      expect(new URL(url).searchParams.has("sort")).toBe(false);
    }
    // Client sort over the full scan (status rank, then created desc —
    // priorities differ here so sort by the documented contract keys).
    const { sortTasksForListing, getPriorityRank } = await import(
      "../../../src/core/task-listing.js"
    );
    const { toLocalTask } = await import("../../../src/core/remote-task-store.js");
    void getPriorityRank;
    const mapped = full.data.tasks
      .map((r) => toLocalTask(r as never))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    const sorted = sortTasksForListing(mapped);
    // One-request page for the same K.
    const seenTopK: string[] = [];
    mockKanbanServer(rows, seenTopK);
    const topK = await fetchSaasTasks("b-1",  { projectDir: "/test-project", sort: "kanban", limit: 2 });
    expect(topK.ok).toBe(true);
    if (!topK.ok) return;
    expect(seenTopK).toHaveLength(1);
    expect(topK.data.tasks.map((t) => t.id)).toEqual(sorted.slice(0, 2).map((t) => t.id));
  });

  it("a bare limit without sort is NOT a row cap (full scan, historical cost)", async () => {
    const { rows } = kanbanBoard();
    // 600 rows: full scan at default pages costs >1 request; the point is
    // the limit alone never caps — every row still comes back.
    const big = Array.from({ length: 600 }, (_, i) => ({
      ...SAMPLE_TASK,
      id: `task-${i}`,
      status: "todo",
      createdAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    const seen: string[] = [];
    mockKanbanServer(big, seen);
    const result = await fetchSaasTasks("b-1",  { projectDir: "/test-project", limit: 1 } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks).toHaveLength(600);
    expect(seen.length).toBeGreaterThan(1);
    for (const url of seen) {
      expect(new URL(url).searchParams.has("sort")).toBe(false);
    }
    void rows;
  });

  it("an old server that 400s sort falls back to the full scan (never wrong rows)", async () => {
    const { rows } = kanbanBoard();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        const u = new URL(url);
        if (u.searchParams.get("sort") !== null) {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: () => Promise.resolve({ error: 'sort must be "kanban"', code: "INVALID_SORT" }),
          });
        }
        const limit = Number(u.searchParams.get("limit") ?? "100");
        const offset = Number(u.searchParams.get("cursor") ?? "0");
        const page = rows.slice(offset, offset + limit);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: page,
              nextCursor: offset + page.length < rows.length ? String(offset + page.length) : null,
            }),
        });
      }),
    );
    const result = await fetchSaasTasks("b-1",  { projectDir: "/test-project", sort: "kanban", limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1 refused top-K + the full scan pages.
    expect(seen.length).toBeGreaterThan(1);
    expect(result.data.tasks).toHaveLength(rows.length);
  });

  it("an order echo that is not the kanban order falls back to the full scan", async () => {
    const { rows } = kanbanBoard();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        const u = new URL(url);
        if (u.searchParams.get("sort") !== null) {
          // Old server ignoring ?sort=: default order, honestly echoed.
          const ordered = [...rows].sort(
            (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
          );
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ items: ordered.slice(0, 1), nextCursor: null, order: ["createdAt:desc"] }),
          });
        }
        const limit = Number(u.searchParams.get("limit") ?? "100");
        const offset = Number(u.searchParams.get("cursor") ?? "0");
        const page = rows.slice(offset, offset + limit);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: page,
              nextCursor: offset + page.length < rows.length ? String(offset + page.length) : null,
            }),
        });
      }),
    );
    const result = await fetchSaasTasks("b-1",  { projectDir: "/test-project", sort: "kanban", limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen.length).toBeGreaterThan(1);
    expect(result.data.tasks).toHaveLength(rows.length);
  });

  it("--limit 1 on a 1,874-task board is ONE request with the kanban top row", async () => {
    // Mirrors the LANE Q 1,874-task evidence board: 300 in-progress heads in
    // kanban order, then todo/rest. The kanban top-1 is the first head.
    const board = Array.from({ length: 1874 }, (_, i) => ({
      ...SAMPLE_TASK,
      id: `task-${String(i).padStart(4, "0")}`,
      status: i < 300 ? "in-progress" : "todo",
      createdAt: `2026-02-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    const seen: string[] = [];
    mockKanbanServer(board, seen);
    const result = await fetchSaasTasks("b-1",  { projectDir: "/test-project", sort: "kanban", limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0] as string).searchParams.get("sort")).toBe("kanban");
    expect(result.data.tasks.map((t) => t.id)).toEqual(["task-0000"]);
  });
});

describe("fetchSaasTasks — roots scope (ticket 05076246, LANE Z)", () => {
  const KANBAN_ORDER = ["status:asc", "priority:asc", "created:desc", "id:asc"];
  /**
   * Board with a child (parent link on its own links) so a scope-ignoring
   * server is detectable: the roots page must not contain the child row.
   */
  function rootsBoard() {
    return [
      { ...SAMPLE_TASK, id: "root-1", status: "todo", createdAt: "2026-03-01T00:00:00.000Z" },
      { ...SAMPLE_TASK, id: "root-2", status: "todo", createdAt: "2026-02-01T00:00:00.000Z" },
      {
        ...SAMPLE_TASK,
        id: "kid-1",
        status: "todo",
        createdAt: "2026-04-01T00:00:00.000Z",
        links: [{ taskId: "root-1", type: "parent" }],
      },
    ];
  }
  function mockRootsServer(all: Array<typeof SAMPLE_TASK>, seen: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        const u = new URL(url);
        const sort = u.searchParams.get("sort");
        const scope = u.searchParams.get("scope");
        const limit = Number(u.searchParams.get("limit") ?? "100");
        const rows = scope === "roots"
          ? all.filter(
              (t) =>
                !(
                  Array.isArray((t as { links?: unknown }).links) &&
                  ((t as { links: Array<{ type?: unknown }> }).links ?? []).some(
                    (l) => typeof l === "object" && l !== null && l.type === "parent",
                  )
                ),
            )
          : all;
        const page = rows.slice(0, limit);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: page,
              nextCursor: null,
              ...(sort === "kanban" ? { order: [...KANBAN_ORDER] } : {}),
            }),
        });
      }),
    );
  }

  it("scope=roots&sort=kanban&limit=K is ONE request returning only roots", async () => {
    const seen: string[] = [];
    mockRootsServer(rootsBoard(), seen);
    const result = await fetchSaasTasks("b-1",  { projectDir: "/test-project", scope: "roots", sort: "kanban", limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen).toHaveLength(1);
    const u = new URL(seen[0] as string);
    expect(u.searchParams.get("scope")).toBe("roots");
    expect(u.searchParams.get("sort")).toBe("kanban");
    expect(u.searchParams.get("limit")).toBe("2");
    expect(result.data.tasks.map((t) => t.id)).toEqual(["root-1", "root-2"]);
  });

  it("a scope-ignoring old server (child in the page) falls back to the full scan", async () => {
    const all = rootsBoard();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        const u = new URL(url);
        if (u.searchParams.get("scope") !== null) {
          // Old server: ignores ?scope= and answers peers (child first —
          // newest createdAt) with the kanban order echo.
          const ordered = [...all].sort(
            (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
          );
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: ordered.slice(0, Number(u.searchParams.get("limit") ?? "100")),
                nextCursor: null,
                order: [...KANBAN_ORDER],
              }),
          });
        }
        const limit = Number(u.searchParams.get("limit") ?? "100");
        const offset = Number(u.searchParams.get("cursor") ?? "0");
        const page = all.slice(offset, offset + limit);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: page,
              nextCursor: offset + page.length < all.length ? String(offset + page.length) : null,
            }),
        });
      }),
    );
    const result = await fetchSaasTasks("b-1",  { projectDir: "/test-project", scope: "roots", sort: "kanban", limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1 refused top-K (child leaked) + the full scan pages.
    expect(seen.length).toBeGreaterThan(1);
    expect(result.data.tasks).toHaveLength(all.length);
  });

  it("scope without sort+limit is ignored (full scan, historical cost)", async () => {
    const seen: string[] = [];
    mockRootsServer(rootsBoard(), seen);
    const result = await fetchSaasTasks("b-1",  { projectDir: "/test-project", scope: "roots" } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks).toHaveLength(3);
    for (const url of seen) {
      expect(new URL(url).searchParams.has("scope")).toBe(false);
    }
  });
});
