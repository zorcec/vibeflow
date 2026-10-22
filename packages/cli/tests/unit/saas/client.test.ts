import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("../../../src/auth/token.js", () => ({
  readToken: vi.fn(),
}));

import * as tokenModule from "../../../src/auth/token.js";
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
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json: () => Promise.resolve(response),
    }),
  );
}

beforeEach(() => {
  vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
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
    const result = await fetchSaasTasks(undefined, { hydrate: true });
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
    const result = await fetchSaasTasks();
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
    const result = await fetchSaasTasks();
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
    const result = await fetchSaasTasks(undefined, { hydrate: true });
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
    await fetchSaasTasks("b-2");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("boardId=b-2");
  });

  it("hits the v0 tasks list, never the deleted cloud legacy surface", async () => {
    mockFetch({ tasks: [], boardId: "b-1" });
    await fetchSaasTasks("b-1");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v0/tasks");
    expect((fetchCall[0] as string)).not.toContain("/api/cli/");
  });

  it("uses VIBEFLOW_API_URL env var when set", async () => {
    process.env.VIBEFLOW_API_URL = "http://custom-api:9000";
    mockFetch({ tasks: [], boardId: "b-x" });
    await fetchSaasTasks();
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("custom-api:9000");
  });

  it("returns NOT_AUTHENTICATED when not authenticated", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const result = await fetchSaasTasks();
    expect(result).toEqual({ ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } });
  });

  it("returns HTTP_ERROR when response is not ok", async () => {
    mockFetch(null, false);
    const result = await fetchSaasTasks();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("HTTP_ERROR");
  });

  it("returns NETWORK_ERROR when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await fetchSaasTasks();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("sends Authorization header with Bearer token", async () => {
    mockFetch({ tasks: [], boardId: "b-1" });
    await fetchSaasTasks();
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("uses default API URL when VIBEFLOW_API_URL is not set", async () => {
    delete process.env.VIBEFLOW_API_URL;
    mockFetch({ tasks: [], boardId: "b-1" });
    await fetchSaasTasks();
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("https://app.vibeflow.tools");
  });
});

describe("updateSaasTask", () => {
  it("returns updated task on success", async () => {
    mockFetch(SAMPLE_TASK);
    const result = await updateSaasTask("task-1", { status: "in-progress" });
    expect(result).toEqual({ ok: true, data: { task: SAMPLE_TASK, warning: undefined } });
  });

  it("maps CLI status to SaaS status in request body", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { status: "in-progress" });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.status).toBe("in_progress");
  });

  it("returns warning when server provides one", async () => {
    mockFetch({ ...SAMPLE_TASK, warning: "Task is already in-progress by another user" });
    const result = await updateSaasTask("task-1", { status: "in-progress" });
    expect(result).toEqual({ ok: true, data: { task: SAMPLE_TASK, warning: "Task is already in-progress by another user" } });
  });

  it("returns NOT_AUTHENTICATED when not authenticated", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const result = await updateSaasTask("task-1", {});
    expect(result).toEqual({ ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } });
  });

  it("returns error when response is not ok", async () => {
    mockFetch(null, false);
    const result = await updateSaasTask("task-1", { title: "New Title" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["HTTP_ERROR", "NETWORK_ERROR"]).toContain(result.error.code);
  });

  it("returns NETWORK_ERROR when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await updateSaasTask("task-1", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("sends Authorization header with Bearer token", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { status: "in-progress" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("sends PATCH request to correct URL", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { status: "in-progress" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v0/tasks/task-1");
    expect((fetchCall[1] as RequestInit).method).toBe("PATCH");
  });

  it("never hits the deleted cloud legacy surface", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { status: "todo" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).not.toContain("/api/cli/");
  });

  it("sends Content-Type header with JSON body", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { status: "in-progress" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends verified:true in the PATCH body", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { verified: true });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.verified).toBe(true);
  });

  it("sends verified:false as a real verdict", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { verified: false });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.verified).toBe(false);
  });

  it("sends verified:null to clear the verdict (not false)", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { verified: null });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect("verified" in body).toBe(true);
    expect(body.verified).toBeNull();
    expect(body.verified).not.toBe(false);
  });

  it("omits verified when no verdict is supplied (leaves the server value untouched)", async () => {
    mockFetch(SAMPLE_TASK);
    await updateSaasTask("task-1", { title: "New Title" });
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
    });
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
    });
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
    const result = await fetchSaasTasks(undefined, { hydrate: true });
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
    const result = await fetchSaasTasks();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(seen.some((u) => u.includes("cursor=cursor-1"))).toBe(true);
  });

  it("fails loudly instead of half-reading when pages never end (no silent page-cap stop)", async () => {
    // A cursor the server keeps answering forever: the read must refuse
    // with BOARD_TRUNCATED after the cap rather than returning the first
    // window of pages as if it were the whole board (that silent stop is
    // what let a child outside the window bypass the delete guard).
    const seen = mockV0({
      pages: [{ items: [{ ...V0_ITEM, id: "a" }], nextCursor: "cursor-forever" }],
    });
    const result = await fetchSaasTasks();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("BOARD_TRUNCATED");
    expect(result.error.message).toContain("refusing a partial board");
    expect(seen).toHaveLength(SAAS_LIST_MAX_PAGES);
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
    const result = await fetchSaasTasks(undefined, { hydrate: true });
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
    const result = await fetchSaasTasks(undefined, { hydrate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks[0]?.files).toMatchObject([{ name: "evidence.png" }]);
    expect(result.data.tasks[0]?.files![0]?.content).toBeUndefined();
    expect(seen.some((u) => u.endsWith("/files/f9"))).toBe(false);
  });

  it("tolerates the legacy { tasks } envelope (pre-cutover fakes)", async () => {
    mockFetch({ tasks: [SAMPLE_TASK], boardId: "board-1" });
    const result = await fetchSaasTasks(undefined, { hydrate: true });
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
    const result = await fetchSaasTasks(undefined, { hydrate: true });
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
    const result = await fetchSaasTasks();
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
    const result = await fetchSaasTasks();
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
    const result = await fetchSaasTaskDetail("ext-9");
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
    const result = await fetchSaasTaskDetail("ghost");
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
    const result = await fetchSaasTaskDetail("ext-9");
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
    const result = await fetchSaasTaskDetail("ext-9");
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
    const result = await fetchSaasTasks();
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
    const result = await fetchSaasTasks();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NETWORK_ERROR");
    expect(result.error.message).toBe("fetch failed");
  });
});

describe("addSaasComment", () => {
  it("returns created comment on success", async () => {
    mockFetch(V0_COMMENT);
    const result = await addSaasComment("task-1", "Hello");
    expect(result).toEqual({ ok: true, data: SAMPLE_COMMENT });
  });

  it("returns NOT_AUTHENTICATED when not authenticated", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const result = await addSaasComment("task-1", "Hello");
    expect(result).toEqual({ ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } });
  });

  it("returns error when response is not ok", async () => {
    mockFetch(null, false);
    const result = await addSaasComment("task-1", "Hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["HTTP_ERROR", "NETWORK_ERROR"]).toContain(result.error.code);
  });

  it("returns NETWORK_ERROR when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await addSaasComment("task-1", "Hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("sends POST request with Authorization header", async () => {
    mockFetch(V0_COMMENT);
    await addSaasComment("task-1", "Hello");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect((fetchCall[1] as RequestInit).method).toBe("POST");
  });

  it("sends comment body in JSON payload", async () => {
    mockFetch(V0_COMMENT);
    await addSaasComment("task-1", "Test comment");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
    expect(body.text).toBe("Test comment");
  });

  it("posts comments to the v0 path", async () => {
    mockFetch(V0_COMMENT);
    await addSaasComment("task-1", "Hello");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v0/tasks/task-1/comments");
  });
});

describe("fetchSaasComments", () => {
  it("returns comments on success", async () => {
    mockFetch({ comments: [V0_COMMENT] });
    const result = await fetchSaasComments("task-1");
    expect(result).toEqual([SAMPLE_COMMENT]);
  });

  it("returns null when not authenticated", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const result = await fetchSaasComments("task-1");
    expect(result).toBeNull();
  });

  it("returns null when response is not ok", async () => {
    mockFetch(null, false);
    const result = await fetchSaasComments("task-1");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await fetchSaasComments("task-1");
    expect(result).toBeNull();
  });

  it("sends GET request with Authorization header", async () => {
    mockFetch({ comments: [V0_COMMENT] });
    await fetchSaasComments("task-1");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("requests comments from correct URL", async () => {
    mockFetch({ comments: [V0_COMMENT] });
    await fetchSaasComments("task-1");
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
    const result = await fetchSaasComments("task-9");
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
    const result = await createSaasTask({ title: "New Task" });
    expect(result).toEqual({ ok: true, data: SAMPLE_TASK });
  });

  it("returns NOT_AUTHENTICATED when not authenticated", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const result = await createSaasTask({ title: "New Task" });
    expect(result).toEqual({ ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } });
  });

  it("returns error when response is not ok", async () => {
    mockFetch(null, false);
    const result = await createSaasTask({ title: "New Task" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["HTTP_ERROR", "NETWORK_ERROR"]).toContain(result.error.code);
  });

  it("returns NETWORK_ERROR when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await createSaasTask({ title: "New Task" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("sends POST request with Authorization header", async () => {
    mockFetch(SAMPLE_TASK);
    await createSaasTask({ title: "New Task" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect((fetchCall[1] as RequestInit).method).toBe("POST");
  });

  it("sends task params in JSON body", async () => {
    mockFetch(SAMPLE_TASK);
    await createSaasTask({ title: "Test Task", description: "Test desc" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
    expect(body.title).toBe("Test Task");
    expect(body.description).toBe("Test desc");
  });

  it("requests tasks from correct URL", async () => {
    mockFetch(SAMPLE_TASK);
    await createSaasTask({ title: "New Task" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v0/tasks");
    expect((fetchCall[0] as string)).not.toContain("/api/cli/");
  });

  it("sends links in the POST body (the online spelling of --parent)", async () => {
    mockFetch(SAMPLE_TASK);
    await createSaasTask({
      title: "Child",
      links: [{ taskId: "parent-1", type: "parent" }],
    });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.links).toEqual([{ taskId: "parent-1", type: "parent" }]);
  });

  it("carries the server refusal code through as serverCode", async () => {
    mockFetch({ error: "Parent target task ghost not found", code: "INVALID_LINKS" }, false);
    const result = await createSaasTask({
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
    const result = await createSaasTask({ title: "New Task" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.serverCode).toBeUndefined();
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
    const result = await deleteSaasTask("abc123");
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
    const result = await deleteSaasTask("p1");
    expect(result).toEqual({
      ok: true,
      data: { id: "p1", deletedIds: ["p1", "c1", "g1"] },
    });
  });

  it("falls back to the requested id alone when the body carries no ids (pre-cascade fakes)", async () => {
    mockDelete({ success: true }, true);
    const result = await deleteSaasTask("abc123");
    expect(result).toEqual({
      ok: true,
      data: { id: "abc123", deletedIds: ["abc123"] },
    });
  });

  it("answers TASK_NOT_FOUND on a 404 (deleted between listing and request)", async () => {
    mockDelete({ error: "Task not found", code: "NOT_FOUND" }, false, 404);
    const result = await deleteSaasTask("gone");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_NOT_FOUND");
      expect(result.error.status).toBe(404);
    }
  });

  it("carries other HTTP refusals with status and path", async () => {
    mockDelete({ error: "Forbidden", code: "FORBIDDEN" }, false, 403);
    const result = await deleteSaasTask("abc123");
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
    const result = await deleteSaasTask("abc123");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NETWORK_ERROR");
  });

  it("answers NOT_AUTHENTICATED without a token and sends nothing", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const result = await deleteSaasTask("abc123");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_AUTHENTICATED");
    expect(spy).not.toHaveBeenCalled();
  });
});
