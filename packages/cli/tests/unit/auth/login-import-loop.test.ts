import { describe, it, expect, vi, afterEach } from "vitest";
import { createTasksOneByOne } from "../../../src/auth/login.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createTasksOneByOne (v1 import loop)", () => {
  it("POSTs once per task to /api/v1/tasks with the board id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ task: { id: "x" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tasks = [
      { id: "a", title: "A", status: "todo" },
      { id: "b", title: "B", status: "todo" },
      { id: "c", title: "C", status: "todo" },
    ];
    const result = await createTasksOneByOne(
      "https://freemium.vibeflow.tools",
      "tok",
      "board-1",
      tasks,
    );

    expect(result).toEqual({ imported: 3, skipped: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("https://freemium.vibeflow.tools/api/v1/tasks");
      expect(call[1].method).toBe("POST");
      expect(call[1].headers.Authorization).toBe("Bearer tok");
      expect(JSON.parse(call[1].body).boardId).toBe("board-1");
    }
    // No batch import call is ever made.
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/cli/import")),
    ).toBe(false);
  });

  it("counts non-ok responses as skipped", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 409 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTasksOneByOne("https://x.test", "tok", "b", [
      { id: "a" },
      { id: "b" },
    ]);

    expect(result).toEqual({ imported: 1, skipped: 1 });
  });
});
