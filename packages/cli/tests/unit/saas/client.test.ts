import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("../../../src/auth/token.js", () => ({
  readToken: vi.fn(),
}));

import * as tokenModule from "../../../src/auth/token.js";
import {
  toCliStatus,
  toSaasStatus,
  fetchSaasTasks,
  updateSaasTask,
  addSaasComment,
  fetchSaasComments,
  createSaasTask,
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

const SAMPLE_COMMENT = {
  id: "comment-1",
  taskId: "task-1",
  body: "Hello",
  authorId: "user-1",
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

  // v1 speaks hyphenated statuses on the wire; the deleted legacy surface
  // spoke snake_case. Both must resolve — otherwise every in-progress task
  // reads back as the `?? "todo"` fallback.
  it("maps the v1 hyphenated in-progress spelling (not just snake_case)", () => {
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
  it("returns tasks on success (hydrated with the legacy comments/files shape)", async () => {
    mockFetch({ tasks: [SAMPLE_TASK], boardId: "board-1" });
    const result = await fetchSaasTasks();
    // The v1 read hydrates comments/files per task (best-effort `[]` when
    // the subpaths answer nothing shaped) — the legacy row keeps its fields.
    expect(result).toEqual({
      ok: true,
      data: {
        tasks: [{ ...SAMPLE_TASK, comments: [], files: [] }],
        boardId: "",
      },
    });
  });

  it("passes boardId query param when provided", async () => {
    mockFetch({ tasks: [], boardId: "b-2" });
    await fetchSaasTasks("b-2");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("boardId=b-2");
  });

  it("hits the v1 tasks list, never the deleted cloud legacy surface", async () => {
    mockFetch({ tasks: [], boardId: "b-1" });
    await fetchSaasTasks("b-1");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v1/tasks");
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
    expect((fetchCall[0] as string)).toContain("https://freemium.vibeflow.tools");
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
    expect((fetchCall[0] as string)).toContain("/api/v1/tasks/task-1");
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
});

describe("fetchSaasTasks — v1 envelope", () => {
  const V1_ITEM = {
    id: "ext-1",
    externalId: "ext-1",
    cloudId: "cloud-1",
    title: "V1 task",
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
  function mockV1(opts: {
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
        if (/\/api\/v1\/tasks\/[^/]+\/comments$/.test(url)) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ comments: opts.comments ?? [] }),
          });
        }
        if (/\/api\/v1\/tasks\/[^/]+\/files$/.test(url)) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ files: opts.files ?? [] }),
          });
        }
        if (/\/api\/v1\/tasks\/[^/]+\/files\//.test(url)) {
          const text = opts.fileText?.[url] ?? "";
          return Promise.resolve({ ok: true, text: () => Promise.resolve(text) });
        }
        const pages = opts.pages ?? [{ items: [V1_ITEM], nextCursor: null }];
        const page = pages[Math.min(pageIdx++, pages.length - 1)]!;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(page),
        });
      }),
    );
    return seen;
  }

  it("parses the v1 { items, nextCursor } envelope (not the legacy { tasks })", async () => {
    mockV1({});
    const result = await fetchSaasTasks();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks).toHaveLength(1);
    expect(result.data.tasks[0]).toMatchObject({
      id: "ext-1",
      title: "V1 task",
      status: "in-progress",
    });
    // Hydration degrades to empty when the subpaths answer empty.
    expect(result.data.tasks[0]?.comments).toEqual([]);
    expect(result.data.tasks[0]?.files).toEqual([]);
  });

  it("follows nextCursor until the last page", async () => {
    const seen = mockV1({
      pages: [
        { items: [{ ...V1_ITEM, id: "a" }], nextCursor: "cursor-1" },
        { items: [{ ...V1_ITEM, id: "b" }], nextCursor: null },
      ],
    });
    const result = await fetchSaasTasks();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(seen.some((u) => u.includes("cursor=cursor-1"))).toBe(true);
  });

  it("hydrates comments (filling the v1-missing taskId), file rows, and text content", async () => {
    const seen: string[] = [];
    mockV1({
      seen,
      comments: [
        { id: "c1", body: "note", authorId: "u1", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      files: [
        {
          id: "f1",
          name: "field-notes.md",
          mimeType: "text/markdown",
          sizeBytes: 20,
          system: false,
          url: "/api/v1/tasks/ext-1/files/f1",
        },
      ],
      fileText: {
        "https://freemium.vibeflow.tools/api/v1/tasks/ext-1/files/f1":
          "field notes line one\n",
      },
    });
    const result = await fetchSaasTasks();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = result.data.tasks[0]!;
    expect(task.comments).toEqual([
      {
        id: "c1",
        body: "note",
        authorId: "u1",
        createdAt: "2026-01-01T00:00:00.000Z",
        taskId: "ext-1",
      },
    ]);
    expect(task.files).toHaveLength(1);
    expect(task.files![0]).toMatchObject({
      name: "field-notes.md",
      size: 20,
      url: "https://freemium.vibeflow.tools/api/v1/tasks/ext-1/files/f1",
      content: "field notes line one\n",
      system: false,
    });
  });

  it("skips content download for binary attachments", async () => {
    const seen: string[] = [];
    mockV1({
      seen,
      files: [
        {
          id: "f9",
          name: "evidence.png",
          mimeType: "image/png",
          sizeBytes: 70,
          url: "/api/v1/tasks/ext-1/files/f9",
        },
      ],
    });
    const result = await fetchSaasTasks();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks[0]?.files).toMatchObject([{ name: "evidence.png" }]);
    expect(result.data.tasks[0]?.files![0]?.content).toBeUndefined();
    expect(seen.some((u) => u.endsWith("/files/f9"))).toBe(false);
  });

  it("tolerates the legacy { tasks } envelope (pre-cutover fakes)", async () => {
    mockFetch({ tasks: [SAMPLE_TASK], boardId: "board-1" });
    const result = await fetchSaasTasks();
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
          json: () => Promise.resolve({ items: [V1_ITEM], nextCursor: null }),
        });
      }),
    );
    const result = await fetchSaasTasks();
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

describe("addSaasComment", () => {
  it("returns created comment on success", async () => {
    mockFetch({ comment: SAMPLE_COMMENT });
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
    mockFetch({ comment: SAMPLE_COMMENT });
    await addSaasComment("task-1", "Hello");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect((fetchCall[1] as RequestInit).method).toBe("POST");
  });

  it("sends comment body in JSON payload", async () => {
    mockFetch({ comment: SAMPLE_COMMENT });
    await addSaasComment("task-1", "Test comment");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
    expect(body.body).toBe("Test comment");
  });

  it("posts comments to the v1 path", async () => {
    mockFetch({ comment: SAMPLE_COMMENT });
    await addSaasComment("task-1", "Hello");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v1/tasks/task-1/comments");
  });
});

describe("fetchSaasComments", () => {
  it("returns comments on success", async () => {
    mockFetch({ comments: [SAMPLE_COMMENT] });
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
    mockFetch({ comments: [SAMPLE_COMMENT] });
    await fetchSaasComments("task-1");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("requests comments from correct URL", async () => {
    mockFetch({ comments: [SAMPLE_COMMENT] });
    await fetchSaasComments("task-1");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/v1/tasks/task-1/comments");
  });

  // v1 comment rows carry no `taskId` — the legacy shape did. Fill it so
  // renderers keying on `comment.taskId` keep working.
  it("fills taskId on v1 comment rows that omit it", async () => {
    mockFetch({
      comments: [
        { id: "c1", body: "x", authorId: "u1", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const result = await fetchSaasComments("task-9");
    expect(result).toEqual([
      {
        id: "c1",
        body: "x",
        authorId: "u1",
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
    expect((fetchCall[0] as string)).toContain("/api/v1/tasks");
    expect((fetchCall[0] as string)).not.toContain("/api/cli/");
  });
});
