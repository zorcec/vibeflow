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
  it("returns tasks on success", async () => {
    mockFetch({ tasks: [SAMPLE_TASK], boardId: "board-1" });
    const result = await fetchSaasTasks();
    expect(result).toEqual({ tasks: [SAMPLE_TASK], boardId: "board-1" });
  });

  it("passes boardId query param when provided", async () => {
    mockFetch({ tasks: [], boardId: "b-2" });
    await fetchSaasTasks("b-2");
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("boardId=b-2");
  });

  it("uses VIBEFLOW_API_URL env var when set", async () => {
    process.env.VIBEFLOW_API_URL = "http://custom-api:9000";
    mockFetch({ tasks: [], boardId: "b-x" });
    await fetchSaasTasks();
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("custom-api:9000");
  });

  it("returns null when not authenticated", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const result = await fetchSaasTasks();
    expect(result).toBeNull();
  });

  it("returns null when response is not ok", async () => {
    mockFetch(null, false);
    const result = await fetchSaasTasks();
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await fetchSaasTasks();
    expect(result).toBeNull();
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
    mockFetch({ task: SAMPLE_TASK });
    const result = await updateSaasTask("task-1", { status: "in-progress" });
    expect(result).toEqual({ task: SAMPLE_TASK, warning: undefined });
  });

  it("maps CLI status to SaaS status in request body", async () => {
    mockFetch({ task: SAMPLE_TASK });
    await updateSaasTask("task-1", { status: "in-progress" });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.status).toBe("in_progress");
  });

  it("returns warning when server provides one", async () => {
    mockFetch({ task: SAMPLE_TASK, warning: "Task is already in-progress by another user" });
    const result = await updateSaasTask("task-1", { status: "in-progress" });
    expect(result).toEqual({ task: SAMPLE_TASK, warning: "Task is already in-progress by another user" });
  });

  it("returns null when not authenticated", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const result = await updateSaasTask("task-1", {});
    expect(result).toBeNull();
  });

  it("returns null when response is not ok", async () => {
    mockFetch(null, false);
    const result = await updateSaasTask("task-1", { title: "New Title" });
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await updateSaasTask("task-1", {});
    expect(result).toBeNull();
  });

  it("sends Authorization header with Bearer token", async () => {
    mockFetch({ task: SAMPLE_TASK });
    await updateSaasTask("task-1", { status: "in-progress" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("sends PATCH request to correct URL", async () => {
    mockFetch({ task: SAMPLE_TASK });
    await updateSaasTask("task-1", { status: "in-progress" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/cli/tasks/task-1");
    expect((fetchCall[1] as RequestInit).method).toBe("PATCH");
  });

  it("sends Content-Type header with JSON body", async () => {
    mockFetch({ task: SAMPLE_TASK });
    await updateSaasTask("task-1", { status: "in-progress" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});

describe("addSaasComment", () => {
  it("returns created comment on success", async () => {
    mockFetch({ comment: SAMPLE_COMMENT });
    const result = await addSaasComment("task-1", "Hello");
    expect(result).toEqual(SAMPLE_COMMENT);
  });

  it("returns null when not authenticated", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const result = await addSaasComment("task-1", "Hello");
    expect(result).toBeNull();
  });

  it("returns null when response is not ok", async () => {
    mockFetch(null, false);
    const result = await addSaasComment("task-1", "Hello");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await addSaasComment("task-1", "Hello");
    expect(result).toBeNull();
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
    expect((fetchCall[0] as string)).toContain("/api/cli/tasks/task-1/comments");
  });
});

describe("createSaasTask", () => {
  it("returns created task on success", async () => {
    mockFetch({ task: SAMPLE_TASK });
    const result = await createSaasTask({ title: "New Task" });
    expect(result).toEqual(SAMPLE_TASK);
  });

  it("returns null when not authenticated", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const result = await createSaasTask({ title: "New Task" });
    expect(result).toBeNull();
  });

  it("returns null when response is not ok", async () => {
    mockFetch(null, false);
    const result = await createSaasTask({ title: "New Task" });
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await createSaasTask({ title: "New Task" });
    expect(result).toBeNull();
  });

  it("sends POST request with Authorization header", async () => {
    mockFetch({ task: SAMPLE_TASK });
    await createSaasTask({ title: "New Task" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const options = fetchCall[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect((fetchCall[1] as RequestInit).method).toBe("POST");
  });

  it("sends task params in JSON body", async () => {
    mockFetch({ task: SAMPLE_TASK });
    await createSaasTask({ title: "Test Task", description: "Test desc" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
    expect(body.title).toBe("Test Task");
    expect(body.description).toBe("Test desc");
  });

  it("requests tasks from correct URL", async () => {
    mockFetch({ task: SAMPLE_TASK });
    await createSaasTask({ title: "New Task" });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect((fetchCall[0] as string)).toContain("/api/cli/tasks");
  });
});
