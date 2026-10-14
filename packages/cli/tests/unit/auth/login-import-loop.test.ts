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

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
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

  it("maps each local id to its cloud id from the create envelope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ task: { id: "saas-1", cliId: "a" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ task: { id: "saas-2", cliId: "b" } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTasksOneByOne("https://x.test", "tok", "b", [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);

    expect(result).toEqual({
      imported: 2,
      skipped: 0,
      idMap: { a: "saas-1", b: "saas-2" },
    });
  });

  it("falls back to the local id when the create response carries no cloud id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ task: { id: "x" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTasksOneByOne("https://x.test", "tok", "b", [
      { id: "a", title: "A" },
    ]);

    expect(result.idMap).toEqual({ a: "x" });
  });

  it("omits boardId from the create body when no board is selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ task: { id: "saas-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTasksOneByOne("https://x.test", "tok", undefined, [
      { id: "a", title: "A" },
    ]);

    expect(result.imported).toBe(1);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string);
    expect("boardId" in body).toBe(false);
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

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    // The failed task contributes no id mapping.
    expect(result.idMap).toEqual({ a: "a" });
  });

  // Regression pin: the loop used to spread the whole local task record
  // into the create body. A local parent link names a LOCAL id the cloud
  // has never seen, so v1's parent-target validation answered 400 and a
  // fresh 3-task push with one parent/child pair reported
  // `Pushed 2 … Skipped 1`. The deleted batch import never validated links
  // (they did not round-trip), so the loop drops them — all new tasks push.
  it("drops links so a parent/child pair fully imports", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ task: { id: "cloud-x" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTasksOneByOne("https://x.test", "tok", "b", [
      { id: "sync-parent", title: "Parent", status: "todo", filePath: "/tmp/x.json" },
      {
        id: "sync-child",
        title: "Child",
        status: "in-progress",
        links: [{ taskId: "sync-parent", type: "parent" }],
      },
      { id: "sync-done", title: "Done", status: "done" },
    ]);

    expect(result).toEqual({
      imported: 3,
      skipped: 0,
      idMap: {
        "sync-parent": "cloud-x",
        "sync-child": "cloud-x",
        "sync-done": "cloud-x",
      },
    });
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body as string);
      expect("links" in body).toBe(false);
    }
    // The v1 field set still travels.
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body as string)).toMatchObject({
      id: "sync-child",
      title: "Child",
      status: "in-progress",
      boardId: "b",
    });
  });

  it("toV1CreateBody strips links, keeps the record, omits undefined/absent boardId", async () => {
    const { toV1CreateBody } = await import("../../../src/auth/login.js");
    expect(toV1CreateBody({ id: "a", title: "A" }, undefined)).toEqual({
      id: "a",
      title: "A",
    });
    expect(
      toV1CreateBody(
        {
          id: "a",
          title: "A",
          links: [{ taskId: "p", type: "parent" }],
          filePath: "x",
          status: undefined,
        },
        "b",
      ),
    ).toEqual({ id: "a", title: "A", filePath: "x", boardId: "b" });
  });
});
