import { describe, it, expect, vi, afterEach } from "vitest";
import { createTasksOneByOne } from "../../../src/auth/login.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createTasksOneByOne (v0 import loop)", () => {
  it("POSTs once per task to /api/v0/tasks with the board id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tasks = [
      { id: "a", title: "A", status: "todo" },
      { id: "b", title: "B", status: "todo" },
      { id: "c", title: "C", status: "todo" },
    ];
    const result = await createTasksOneByOne(
      "https://app.vibeflow.tools",
      "tok",
      "board-1",
      tasks,
    );

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("https://app.vibeflow.tools/api/v0/tasks");
      expect(call[1].method).toBe("POST");
      expect(call[1].headers.Authorization).toBe("Bearer tok");
      expect(JSON.parse(call[1].body).boardId).toBe("board-1");
    }
    // No batch import call is ever made.
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/cli/import")),
    ).toBe(false);
  });

  it("maps each local id to its cloud id from the bare create body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ id: "saas-1", externalId: "a" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "saas-2", externalId: "b" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTasksOneByOne("https://x.test", "tok", "b", [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);

    expect(result).toEqual({
      imported: 2,
      existing: 0,
      skipped: 0,
      idMap: { a: "saas-1", b: "saas-2" },
      attempted: 2,
      failures: [],
      stoppedEarly: null,
      stopMessage: null,
      retryAfter: null,
    });
  });

  it("falls back to the local id when the create response carries no cloud id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "x" }),
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
      json: () => Promise.resolve({ id: "saas-1" }),
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
  // has never seen, so v0's parent-target validation answered 400 and a
  // fresh 3-task push with one parent/child pair reported
  // `Pushed 2 … Skipped 1`. Phase 1 therefore creates WITHOUT links (all
  // new tasks push); phase 2 (`applyPushLinks`) replays them with resolved
  // cloud ids so no link is silently lost.
  it("creates without links in phase 1 so a parent/child pair fully imports", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "cloud-x" }),
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
      existing: 0,
      skipped: 0,
      idMap: {
        "sync-parent": "cloud-x",
        "sync-child": "cloud-x",
        "sync-done": "cloud-x",
      },
      attempted: 3,
      failures: [],
      stoppedEarly: null,
      stopMessage: null,
      retryAfter: null,
    });
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body as string);
      expect("links" in body).toBe(false);
    }
    // The v0 field set still travels.
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body as string)).toMatchObject({
      id: "sync-child",
      title: "Child",
      status: "in-progress",
      boardId: "b",
    });
  });

  describe("applyPushLinks (phase 2: link replay with resolved cloud ids)", () => {
    it("posts each link with the TARGET EXTERNAL ID, not the local id", async () => {
      const { applyPushLinks } = await import("../../../src/auth/login.js");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "cloud-child" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyPushLinks(
        "https://x.test",
        "tok",
        [
          { id: "local-parent", title: "Parent" },
          {
            id: "local-child",
            title: "Child",
            links: [
              { taskId: "local-parent", type: "parent" },
              { taskId: "local-other", type: "relates" },
            ],
          },
          { id: "local-other", title: "Other" },
        ],
        {
          "local-parent": "cloud-parent",
          "local-child": "cloud-child",
          "local-other": "cloud-other",
        },
      );

      expect(result).toEqual({ applied: 2, skipped: [] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Source is the child's cloud id; targets are cloud ids.
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "https://x.test/api/v0/tasks/cloud-child/links",
      );
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toEqual({
        taskId: "cloud-parent",
        type: "parent",
      });
      expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body as string)).toEqual({
        taskId: "cloud-other",
        type: "relates",
      });
      for (const call of fetchMock.mock.calls) {
        expect(call[1].method).toBe("POST");
        expect(call[1].headers.Authorization).toBe("Bearer tok");
      }
    });

    it("skips an unknown-target link and reports it instead of failing", async () => {
      const { applyPushLinks } = await import("../../../src/auth/login.js");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyPushLinks(
        "https://x.test",
        "tok",
        [
          {
            id: "local-child",
            title: "Child",
            links: [
              { taskId: "ghost-target", type: "blocks" },
              { taskId: "local-parent", type: "parent" },
            ],
          },
          { id: "local-parent", title: "Parent" },
        ],
        { "local-child": "cloud-child", "local-parent": "cloud-parent" },
      );

      // The known link still applies; the ghost is reported, not fatal.
      expect(result.applied).toBe(1);
      expect(result.skipped).toEqual([
        {
          from: "local-child",
          to: "ghost-target",
          type: "blocks",
          reason: "link target is not part of this push",
        },
      ]);
      // Ticket 57aff0df: the ghost costs one cliId-lookup GET (which finds
      // nothing — the mock body carries no id) before the clean skip.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("skips malformed link entries and links from uncreated sources", async () => {
      const { applyPushLinks } = await import("../../../src/auth/login.js");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyPushLinks("https://x.test", "tok", [{ id: "a", links: [{ type: "parent" }, { taskId: "b", type: "nonsense" }, { taskId: "b", type: "parent" }] }], {});

      expect(result.applied).toBe(0);
      expect(result.skipped).toHaveLength(3);
      // Ticket 57aff0df: the only fetch is the source cliId-lookup GET
      // for "a" (finds nothing — same skips as before, plus one read).
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("heals a target pushed in an earlier run via cliId lookup (ticket 57aff0df)", async () => {
      const { applyPushLinks } = await import("../../../src/auth/login.js");
      const fetchMock = vi.fn().mockImplementation((_url: unknown, init?: { method?: string }) => {
        // Lookup GETs resolve by cliId; link POSTs succeed.
        if ((init?.method ?? "GET") === "GET") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "cloud-monday" }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal("fetch", fetchMock);

      const idMap: Record<string, string> = { "local-tue": "cloud-tue" };
      const result = await applyPushLinks(
        "https://x.test",
        "tok",
        [
          {
            id: "local-tue",
            title: "Tuesday task",
            links: [{ taskId: "local-mon", type: "relates" }],
          },
        ],
        idMap,
      );
      // The Monday task was never in this run's idMap, yet the link
      // applies — and the healed id is written back so the file phase
      // (which reads this same object) uploads Monday's attachments.
      expect(result).toEqual({ applied: 1, skipped: [] });
      expect(idMap["local-mon"]).toBe("cloud-monday");
      const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
      expect(JSON.parse(post?.[1].body as string)).toEqual({
        taskId: "cloud-monday",
        type: "relates",
      });
      // Break: skip on idMap miss without the lookup — cross-run links
      // (locals deleted between pushes) never heal and stay skipped.
    });

    it("heals a source pushed in an earlier run via cliId lookup (ticket 57aff0df)", async () => {
      const { applyPushLinks } = await import("../../../src/auth/login.js");
      const fetchMock = vi.fn().mockImplementation((_url: unknown, init?: { method?: string }) => {
        if ((init?.method ?? "GET") === "GET") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "cloud-old" }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyPushLinks(
        "https://x.test",
        "tok",
        [
          {
            id: "local-old",
            title: "Old task",
            links: [{ taskId: "local-new", type: "blocks" }],
          },
          { id: "local-new", title: "New task" },
        ],
        { "local-new": "cloud-new" },
      );
      // The source resolved remotely; the link POSTs from its cloud id.
      expect(result).toEqual({ applied: 1, skipped: [] });
      const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
      expect(String(post?.[0])).toBe("https://x.test/api/v0/tasks/cloud-old/links");
      // Break: give up on source miss without the lookup — a source that
      // exists remotely (refused this run, pushed before) loses its links.
    });

    it("is two-phase: no link POST is sent before its target's create", async () => {
      const { applyPushLinks, createTasksOneByOne } = await import(
        "../../../src/auth/login.js"
      );
      const calls: string[] = [];
      const fetchMock = vi.fn().mockImplementation((url: unknown, init?: { body?: string }) => {
        calls.push(String(url));
        if (String(url).endsWith("/links")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }
        const body = JSON.parse(init?.body as string) as { id: string };
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: `cloud-${body.id}` }),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const tasks = [
        { id: "child", title: "Child", links: [{ taskId: "parent", type: "parent" }] },
        { id: "parent", title: "Parent" },
      ];
      // Child listed FIRST: phase 1 still creates both without links.
      const created = await createTasksOneByOne("https://x.test", "tok", "b", tasks);
      const links = await applyPushLinks("https://x.test", "tok", tasks, created.idMap);

      expect(created.imported).toBe(2);
      expect(links).toEqual({ applied: 1, skipped: [] });
      const firstLinkIdx = calls.findIndex((u) => u.endsWith("/links"));
      const lastCreateIdx = calls.map((u) => !u.endsWith("/links")).lastIndexOf(true);
      expect(firstLinkIdx).toBeGreaterThan(lastCreateIdx);
      // The link names the created cloud id even though the child came first.
      const linkCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/links"));
      expect(JSON.parse(linkCall?.[1].body as string)).toEqual({
        taskId: "cloud-parent",
        type: "parent",
      });
    });
  });

  it("toV0CreateBody strips links, keeps the record, omits undefined/absent boardId", async () => {
    const { toV0CreateBody } = await import("../../../src/auth/login.js");
    expect(toV0CreateBody({ id: "a", title: "A" }, undefined)).toEqual({
      id: "a",
      title: "A",
    });
    expect(
      toV0CreateBody(
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
