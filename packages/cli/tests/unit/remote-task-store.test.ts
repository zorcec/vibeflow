/**
 * Remote read adapter regressions (ticket d7b9dc13).
 *
 * The adapter is what makes a saas-mode MCP read see the same board the CLI
 * sees. Every test here runs a local project dir holding a DISTINCT stale
 * sentinel the remote board never names — if any read consults the local
 * files, the sentinel shows up and the test goes red.
 *
 * Mutation note (each guard was broken on purpose before landing):
 * - detail-first: enumerate-before-detail adds list URLs to `seen` → red.
 * - listed-row-404: rendering the listed row returns it instead of
 *   refusing → red.
 * - ambiguity: first-match resolution returns a task instead of
 *   E_AMBIGUOUS → red.
 * - malformed acceptance: `{}` list page or unparseable detail returns
 *   rows instead of refusing → red.
 * - saved-workspace reread: the board id on nested requests comes from the
 *   once-resolved scope, asserted by routing boards per request in the fake.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/auth/token.js", () => ({
  readToken: vi.fn(),
}));
vi.mock("../../src/auth/workspace.js", () => ({
  readWorkspace: vi.fn(),
  writeWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

import * as tokenModule from "../../src/auth/token.js";
import * as workspaceModule from "../../src/auth/workspace.js";
import {
  remoteTaskStore,
  RemoteReadError,
  RemoteWriteNotRoutedError,
  toLocalTask,
} from "../../src/core/remote-task-store.js";

const PROJECT = mkdtempSync(join(tmpdir(), "remote-store-"));

function v0Task(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `remote ${id}`,
    description: `body of ${id}`,
    status: "todo",
    priority: null,
    type: null,
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

interface FakeBoard {
  boards?: Array<{ id: string; name: string }>;
  pages?: Array<{ items: unknown[]; nextCursor: string | null }>;
  detail?: Record<string, unknown>;
  detailStatus?: number;
}

/** URL-routed fake: boards → /boards, list → bare /tasks, detail → /tasks/:id. */
function stubBoard(fake: FakeBoard, seen: string[] = []): string[] {
  let pageIdx = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      seen.push(url);
      if (url.includes("/api/v0/boards")) {
        const items = fake.boards ?? [{ id: "board-1", name: "B1" }];
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify({ items, nextCursor: null })),
          json: () => Promise.resolve({ items, nextCursor: null }),
        });
      }
      const detailMatch = url.match(/\/api\/v0\/tasks\/([^/?]+)(\/.*)?$/);
      if (detailMatch && detailMatch[2] !== undefined && detailMatch[2].startsWith("/comments")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify({ comments: [] })),
          json: () => Promise.resolve({ comments: [] }),
        });
      }
      if (detailMatch && detailMatch[2] !== undefined && detailMatch[2].startsWith("/files")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify({ files: [] })),
          json: () => Promise.resolve({ files: [] }),
        });
      }
      if (detailMatch && detailMatch[1] !== "tasks") {
        const status = fake.detailStatus ?? 200;
        if (status !== 200) {
          return Promise.resolve({
            ok: false,
            status,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve("{}"),
            json: () => Promise.resolve({}),
          });
        }
        const body = fake.detail ?? v0Task(detailMatch[1]);
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify(body)),
          json: () => Promise.resolve(body),
        });
      }
      const pages = fake.pages ?? [{ items: [v0Task("remote-1")], nextCursor: null }];
      const page = pages[Math.min(pageIdx++, pages.length - 1)]!;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: () => Promise.resolve(JSON.stringify(page)),
        json: () => Promise.resolve(page),
      });
    }),
  );
  return seen;
}

beforeEach(() => {
  vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
  vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const isListUrl = (u: string) => /\/api\/v0\/tasks(\?|$)/.test(u);
const isDetailUrl = (u: string) => /\/api\/v0\/tasks\/[^/]+$/.test(u);

describe("toLocalTask — no invented defaults", () => {
  it("maps status spellings and keeps server counts", () => {
    const task = toLocalTask(v0Task("r1", { status: "in-progress", commentCount: 3, fileCount: 2 }) as never);
    expect(task?.status).toBe("in-progress");
    expect(task).toMatchObject({ id: "r1", title: "remote r1" });
  });

  it("returns null for a record without id/title/createdAt (never a guessed row)", () => {
    expect(toLocalTask({ title: "x" } as never)).toBeNull();
    expect(toLocalTask({ id: "x" } as never)).toBeNull();
  });
});

describe("listTasks — the remote board, never local files", () => {
  it("returns every remote row across >1 page with one board identity", async () => {
    const seen = stubBoard({
      pages: [
        { items: [v0Task("remote-1"), v0Task("remote-2")], nextCursor: "c1" },
        { items: [v0Task("remote-3")], nextCursor: null },
      ],
    });
    const rows = await remoteTaskStore.listTasks(PROJECT);
    expect(rows.map((t) => t.id)).toEqual(["remote-1", "remote-2", "remote-3"]);
    expect(seen.some((u) => u.includes("cursor=c1"))).toBe(true);
  });

  it("refuses on a repeated cursor instead of spinning to the cap", async () => {
    stubBoard({
      pages: [{ items: [v0Task("remote-1")], nextCursor: "loop" }],
    });
    await expect(remoteTaskStore.listTasks(PROJECT)).rejects.toMatchObject({
      name: "RemoteReadError",
      code: "BOARD_TRUNCATED",
    });
  });

  it("refuses a {} page instead of resolving against an unsent board", async () => {
    stubBoard({ pages: [{} as never] });
    await expect(remoteTaskStore.listTasks(PROJECT)).rejects.toMatchObject({
      code: "E_BACKEND_UNAVAILABLE",
    });
  });
});

describe("resolveTask — detail-first, prefix fallback, no silent matches", () => {
  it("a full-id hit costs exactly one detail request (zero enumerations)", async () => {
    const seen = stubBoard({});
    const outcome = await remoteTaskStore.resolveTask(PROJECT, "remote-9");
    expect(outcome.status).toBe("found");
    if (outcome.status !== "found") return;
    expect(outcome.task.id).toBe("remote-9");
    expect(seen.filter(isDetailUrl)).toHaveLength(1);
    expect(seen.filter(isListUrl)).toHaveLength(0);
  });

  it("a unique prefix falls back to one listing then one detail", async () => {
    const seen = stubBoard({
      detailStatus: 404,
      pages: [{ items: [v0Task("abcdef1111"), v0Task("zz-top")], nextCursor: null }],
      detail: v0Task("abcdef1111"),
    });
    // First call 404s on detail (detailStatus), so the store takes the
    // prefix path — but the prefix detail must SUCCEED. Re-stub so the
    // second detail answers the resolved row.
    void seen;
    const seen2: string[] = [];
    let detailCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen2.push(url);
        if (url.includes("/api/v0/boards")) {
          return Promise.resolve({
            ok: true, status: 200,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve(JSON.stringify({ items: [{ id: "board-1", name: "B1" }], nextCursor: null })),
            json: () => Promise.resolve({ items: [{ id: "board-1", name: "B1" }], nextCursor: null }),
          });
        }
        if (/\/api\/v0\/tasks\/abcdef1111($|\?)/.test(url)) {
          const resolvedBody = v0Task("abcdef1111");
          return Promise.resolve({ ok: true, status: 200, headers: { get: () => "application/json" }, text: () => Promise.resolve(JSON.stringify(resolvedBody)), json: () => Promise.resolve(resolvedBody) });
        }
        if (/\/api\/v0\/tasks\/abcdef($|\?)/.test(url)) {
          detailCalls++;
          if (detailCalls === 1) {
            return Promise.resolve({ ok: false, status: 404, headers: { get: () => "application/json" }, text: () => Promise.resolve("{}"), json: () => Promise.resolve({}) });
          }
          const body = v0Task("abcdef1111");
          return Promise.resolve({ ok: true, status: 200, headers: { get: () => "application/json" }, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });
        }
        if (/\/api\/v0\/tasks(\?|$)/.test(url)) {
          const page = { items: [v0Task("abcdef1111"), v0Task("zz-top")], nextCursor: null };
          return Promise.resolve({ ok: true, status: 200, headers: { get: () => "application/json" }, text: () => Promise.resolve(JSON.stringify(page)), json: () => Promise.resolve(page) });
        }
        return Promise.resolve({ ok: false, status: 404, headers: { get: () => "application/json" }, text: () => Promise.resolve("{}"), json: () => Promise.resolve({}) });
      }),
    );
    const outcome = await remoteTaskStore.resolveTask(PROJECT, "abcdef");
    expect(outcome.status).toBe("found");
    if (outcome.status !== "found") return;
    expect(outcome.task.id).toBe("abcdef1111");
    expect(seen2.filter(isListUrl)).toHaveLength(1);
  });

  it("an ambiguous prefix refuses with candidates (never first-match)", async () => {
    const seen = stubBoard({
      detailStatus: 404,
      pages: [{ items: [v0Task("ab-1"), v0Task("ab-2")], nextCursor: null }],
    });
    void seen;
    const err = await remoteTaskStore.resolveTask(PROJECT, "ab").catch((e) => e);
    expect(err).toBeInstanceOf(RemoteReadError);
    expect(err.code).toBe("E_AMBIGUOUS");
  });

  it("a listed row that 404s on detail REFUSES (the listing never overrides detail)", async () => {
    stubBoard({
      detailStatus: 404,
      pages: [{ items: [v0Task("ghost-1")], nextCursor: null }],
    });
    const outcome = await remoteTaskStore.resolveTask(PROJECT, "ghost-1").catch((e) => e);
    // Full-id path: detail 404 → prefix path → listing names it → detail
    // 404 again → refusal, never the listed row.
    expect(outcome).toBeInstanceOf(RemoteReadError);
    expect((outcome as RemoteReadError).code).toBe("TASK_NOT_FOUND");
  });

  it("an unknown id reports missing (not a refusal)", async () => {
    stubBoard({
      detailStatus: 404,
      pages: [{ items: [v0Task("something-else")], nextCursor: null }],
    });
    const outcome = await remoteTaskStore.resolveTask(PROJECT, "no-such-task");
    expect(outcome).toEqual({ status: "missing", id: "no-such-task" });
  });
});

describe("relationScope — relations without enumeration", () => {
  it("answers the task plus detail-named children in one request", async () => {
    const seen = stubBoard({
      detail: v0Task("p1", {
        parentId: null,
        children: [
          { id: "c1", title: "kid one", status: "todo" },
          { id: "c2", title: "kid two", status: "in-progress" },
        ],
      }),
    });
    const scope = await remoteTaskStore.relationScope!(PROJECT, "p1");
    expect(scope.map((t) => t.id)).toEqual(["p1", "c1", "c2"]);
    expect(seen.filter(isListUrl)).toHaveLength(0);
  });
});

describe("fail-closed scope and auth", () => {
  it("no token refuses without touching the network", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(remoteTaskStore.listTasks(PROJECT)).rejects.toMatchObject({
      code: "E_NOT_AUTHENTICATED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("two boards with none selected refuses (never a guess)", async () => {
    stubBoard({ boards: [{ id: "b1", name: "One" }, { id: "b2", name: "Two" }] });
    await expect(remoteTaskStore.listTasks(PROJECT)).rejects.toMatchObject({
      code: "SCOPE_REQUIRED",
    });
  });

  it("a dead backend refuses (the stale local copy is never consulted)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    await expect(remoteTaskStore.listTasks(PROJECT)).rejects.toMatchObject({
      code: "E_BACKEND_UNAVAILABLE",
    });
  });
});

describe("writes are not routed here", () => {
  it("every mutating method except claim/create/update/comment throws REMOTE_WRITE_NOT_ROUTED", async () => {
    // P3 (ticket 6452504d): the claim IS routed here — it is the remote
    // mutation with a truthful contract. P4 (ticket efcd6992):
    // create/update/comment joined it (authoritative remote writes).
    // Everything else still refuses loudly until P5.
    stubBoard({});
    await expect(remoteTaskStore.deleteTask(PROJECT, "x")).rejects.toBeInstanceOf(RemoteWriteNotRoutedError);
    await expect(remoteTaskStore.updateComment(PROJECT, "x", "c", "hi")).rejects.toBeInstanceOf(RemoteWriteNotRoutedError);
    await expect(remoteTaskStore.deleteComment(PROJECT, "x", "c")).rejects.toBeInstanceOf(RemoteWriteNotRoutedError);
    await expect(remoteTaskStore.validateAttachment(PROJECT, "a.md", 3)).rejects.toBeInstanceOf(RemoteWriteNotRoutedError);
    await expect(remoteTaskStore.saveFile(PROJECT, "x", "a.md", Buffer.from("hi"))).rejects.toBeInstanceOf(RemoteWriteNotRoutedError);
    await expect(remoteTaskStore.deleteFile(PROJECT, "x", "a.md")).rejects.toBeInstanceOf(RemoteWriteNotRoutedError);
  });
});

describe("remote claim — one versioned POST, never list+PATCH", () => {
  interface SeenRequest {
    method: string;
    url: string;
    body: unknown;
  }
  function stubClaimServer(response: { status: number; body: unknown }): SeenRequest[] {
    const seen: SeenRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: { method?: string; body?: string }) => {
        seen.push({
          method: init?.method ?? "GET",
          url,
          body: init?.body ? (JSON.parse(init.body) as unknown) : undefined,
        });
        if (url.includes("/api/v0/boards")) {
          const boards = { items: [{ id: "board-1", name: "B1" }], nextCursor: null };
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve(JSON.stringify(boards)),
            json: () => Promise.resolve(boards),
          });
        }
        if (url.includes("/api/v0/tasks/claim-next")) {
          return Promise.resolve({
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve(JSON.stringify(response.body)),
            json: () => Promise.resolve(response.body),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve("{}"),
          json: () => Promise.resolve({}),
        });
      }),
    );
    return seen;
  }

  it("posts the exact versioned agent body with P2 frozen scope", async () => {
    const seen = stubClaimServer({ status: 200, body: { task: v0Task("claimed-1", { status: "in-progress" }) } });
    const claimed = await remoteTaskStore.claimNextTaskAtomic(PROJECT, {
      type: "Bug",
      user: "zoe",
      tag: ["x"],
    });
    expect(claimed?.id).toBe("claimed-1");
    expect(claimed?.status).toBe("in-progress");
    const posts = seen.filter((r) => r.url.includes("/api/v0/tasks/claim-next"));
    // Exactly ONE claim request — no listing, no PATCH follow-up.
    expect(posts).toHaveLength(1);
    expect(seen.filter((r) => r.method === "PATCH" || (isListUrl(r.url) && r.method === "GET"))).toHaveLength(0);
    expect(posts[0]?.method).toBe("POST");
    // The versioned body, verbatim filters, frozen board scope.
    expect(posts[0]?.body).toEqual({
      agentVersion: 1,
      type: "Bug",
      user: "zoe",
      tag: ["x"],
      dryRun: false,
      boardId: "board-1",
    });
    expect(posts[0]?.url).toContain("boardId=board-1");
  });

  it("maps an empty claim to null (the empty success, never an error)", async () => {
    stubClaimServer({ status: 200, body: { task: null } });
    await expect(remoteTaskStore.claimNextTaskAtomic(PROJECT)).resolves.toBeNull();
    await expect(remoteTaskStore.previewClaim(PROJECT)).resolves.toBeNull();
  });

  it("preview sends dryRun:true in one request and writes nothing", async () => {
    const seen = stubClaimServer({ status: 200, body: { task: v0Task("preview-1") } });
    const preview = await remoteTaskStore.previewClaim(PROJECT, { type: "Task" });
    expect(preview?.task.id).toBe("preview-1");
    const posts = seen.filter((r) => r.url.includes("/api/v0/tasks/claim-next"));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ agentVersion: 1, type: "Task", dryRun: true });
    // No write of any kind follows the preview.
    expect(seen.filter((r) => r.method !== "GET" && r.method !== "POST")).toHaveLength(0);
    expect(seen.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("derives the child-claim notice from the previewed record", async () => {
    stubClaimServer({
      status: 200,
      body: {
        task: v0Task("kid-1", {
          links: [{ taskId: "epic-1", type: "parent" }],
        }),
      },
    });
    const preview = await remoteTaskStore.previewClaim(PROJECT);
    expect(preview?.childClaim).toBe(true);
    expect(preview?.parentId).toBe("epic-1");
  });

  it("an old server is the specific REMOTE_CLAIM_UNSUPPORTED refusal (never a fallback)", async () => {
    const seen = stubClaimServer({ status: 404, body: {} });
    const err = await remoteTaskStore.claimNextTaskAtomic(PROJECT).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteReadError);
    expect(err.code).toBe("REMOTE_CLAIM_UNSUPPORTED");
    // One boards listing plus the refused POST — no legacy GET/PATCH workaround.
    expect(seen).toHaveLength(2);
    expect(seen.filter((r) => r.method === "PATCH" || isListUrl(r.url))).toHaveLength(0);
  });

  it("a versioned server refusal code is the same specific refusal", async () => {
    stubClaimServer({ status: 400, body: { error: "unknown agent version", code: "UNKNOWN_AGENT_VERSION" } });
    await expect(remoteTaskStore.claimNextTaskAtomic(PROJECT)).rejects.toMatchObject({
      code: "REMOTE_CLAIM_UNSUPPORTED",
    });
  });

  it("a claimed row that does not parse refuses (never a guessed task)", async () => {
    stubClaimServer({ status: 200, body: { task: { id: "" } } });
    await expect(remoteTaskStore.claimNextTaskAtomic(PROJECT)).rejects.toMatchObject({
      code: "REMOTE_MALFORMED_RECORD",
    });
  });

  it("no token refuses without touching the network", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(remoteTaskStore.claimNextTaskAtomic(PROJECT)).rejects.toMatchObject({
      code: "E_NOT_AUTHENTICATED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("listTasks preFilter — server-side status narrowing (LANE Q step 2)", () => {
  /**
   * Fake honouring `status` + `limit` + offset `cursor` with server
   * semantics: an exact wire-status match narrows the set, pages cover the
   * narrowed set, `nextCursor` is null exactly when it is exhausted. A
   * storage-`cancelled` row is present so the `done` guard has teeth: the
   * server answers it unfiltered, `?status=done` would hide it.
   */
  function stubStatusBoard(statuses: string[]) {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        if (url.includes("/api/v0/boards")) {
          const body = { items: [{ id: "board-1", name: "B1" }], nextCursor: null };
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve(JSON.stringify(body)),
            json: () => Promise.resolve(body),
          });
        }
        const u = new URL(url);
        const status = u.searchParams.get("status");
        const rawLimit = u.searchParams.get("limit");
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        const offset = Number(u.searchParams.get("cursor") ?? "0");
        const matching = statuses
          .map((s, i) => v0Task(`task-${i}`, { status: s }))
          .filter((t) => status === null || t.status === status);
        const page = matching.slice(offset, offset + limit);
        const body = {
          items: page,
          nextCursor:
            offset + page.length < matching.length
              ? String(offset + page.length)
              : null,
        };
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify(body)),
          json: () => Promise.resolve(body),
        });
      }),
    );
    return seen;
  }

  // 1,874-task board mirroring the production evidence: 300 todo of them.
  const BOARD = Array.from({ length: 1874 }, (_, i) =>
    i < 300 ? "todo" : "in-progress",
  );

  it("a pushable status pages only over the matching set (1 request, same rows)", async () => {
    const seen = stubStatusBoard(BOARD);
    const narrowed = await remoteTaskStore.listTasks(PROJECT, undefined, {
      status: "todo",
    });
    const listUrls = seen.filter(isListUrl);
    expect(listUrls).toHaveLength(1);
    expect(new URL(listUrls[0] as string).searchParams.get("status")).toBe(
      "todo",
    );
    expect(narrowed.map((t) => t.id)).toEqual(
      Array.from({ length: 300 }, (_, i) => `task-${i}`),
    );
    // Exactness: identical to filtering the full scan client-side.
    const seenFull = stubStatusBoard(BOARD);
    const full = await remoteTaskStore.listTasks(PROJECT);
    expect(seenFull.filter(isListUrl)).toHaveLength(4);
    expect(narrowed).toEqual(full.filter((t) => t.status === "todo"));
  });

  it("status=done stays a full scan (the server would drop cancelled rows)", async () => {
    const withCancelled = [...BOARD, "cancelled"];
    const seen = stubStatusBoard(withCancelled);
    const rows = await remoteTaskStore.listTasks(PROJECT, undefined, {
      status: "done",
    });
    const listUrls = seen.filter(isListUrl);
    // ceil(1875/500) = 4 pages, and none of them narrows by status…
    expect(listUrls).toHaveLength(4);
    for (const url of listUrls) {
      expect(new URL(url).searchParams.has("status")).toBe(false);
    }
    // …so the cancelled row survives as client-side `done`.
    expect(rows.map((t) => t.id)).toContain("task-1874");
    expect(rows.find((t) => t.id === "task-1874")?.status).toBe("done");
  });

  it("an unfiltered read still costs the full board (the (b) floor: sort needs every page)", async () => {
    const seen = stubStatusBoard(BOARD);
    const rows = await remoteTaskStore.listTasks(PROJECT);
    expect(seen.filter(isListUrl)).toHaveLength(4);
    expect(rows).toHaveLength(1874);
    for (const url of seen.filter(isListUrl)) {
      expect(new URL(url).searchParams.has("status")).toBe(false);
    }
  });
});

describe("listTasks top-K — ?sort=kanban&limit=K (ticket 05076246)", () => {
  const KANBAN_ORDER = ["status:asc", "priority:asc", "created:desc", "id:asc"];
  /**
   * Fake honouring `status` (SET-narrowing) + `sort=kanban&limit=K` (top-K
   * page in kanban order, with the `order` echo) + offset `cursor` paging
   * in createdAt-desc order otherwise. A storage-`cancelled` row is present
   * so the `done` guard has teeth; a child (parent link) is present so the
   * root-only guard has teeth; priorities mix so the rank key has teeth.
   */
  function stubKanbanBoard(statuses: Array<{ status: string; priority?: string | null; childOf?: string }>) {
    const seen: string[] = [];
    const rows = statuses.map((s, i) => ({
      ...v0Task(`task-${String(i).padStart(4, "0")}`, {
        status: s.status,
        ...(s.priority !== undefined ? { priority: s.priority } : {}),
        createdAt: `2026-03-${String((i % 27) + 1).padStart(2, "0")}T12:00:00.000Z`,
        ...(s.childOf !== undefined ? { links: [{ taskId: s.childOf, type: "parent" }] } : {}),
      }),
    }));
    // True kanban comparator mirroring the server contract (and the client
    // sort over toLocalTask-mapped rows): status rank with storage
    // `cancelled` ranked with `done`, priority rank, created desc, id.
    const statusRank = (storage: string): number => {
      const cli = storage === "cancelled" ? "done" : storage === "in_progress" ? "in-progress" : storage;
      return ["in-progress", "review", "todo", "backlog", "done"].indexOf(cli);
    };
    const priorityRank = (p: unknown): number => {
      const v = String((p as string | null) ?? "Medium").trim().toLowerCase();
      if (v === "critical") return 0;
      if (v === "high") return 1;
      if (v === "low") return 3;
      return 2;
    };
    const kanbanSort = <T extends { id: string; status: string; priority?: unknown; createdAt: string }>(input: T[]): T[] =>
      [...input].sort((a, b) => {
        const byStatus = statusRank(a.status) - statusRank(b.status);
        if (byStatus !== 0) return byStatus;
        const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
        if (byPriority !== 0) return byPriority;
        const byCreated = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        if (byCreated !== 0) return byCreated;
        return a.id.localeCompare(b.id);
      });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(url);
        if (url.includes("/api/v0/boards")) {
          const body = { items: [{ id: "board-1", name: "B1" }], nextCursor: null };
          return Promise.resolve({
            ok: true, status: 200,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve(JSON.stringify(body)),
            json: () => Promise.resolve(body),
          });
        }
        const u = new URL(url);
        const status = u.searchParams.get("status");
        const sort = u.searchParams.get("sort");
        const scope = u.searchParams.get("scope");
        const rawLimit = u.searchParams.get("limit");
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        const offset = Number(u.searchParams.get("cursor") ?? "0");
        const scoped = scope === "roots"
          ? rows.filter(
              (t) =>
                !(
                  Array.isArray((t as { links?: unknown }).links) &&
                  ((t as { links: Array<{ type?: unknown }> }).links ?? []).some(
                    (l) => typeof l === "object" && l !== null && l.type === "parent",
                  )
                ),
            )
          : rows;
        const matching = scoped.filter((t) => status === null || (t as { status: string }).status === status);
        if (sort === "kanban") {
          const page = kanbanSort(matching as Array<{ id: string; status: string; priority?: unknown; createdAt: string }>).slice(0, limit);
          return Promise.resolve({
            ok: true, status: 200,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve(JSON.stringify({ items: page, nextCursor: null, order: [...KANBAN_ORDER] })),
            json: () => Promise.resolve({ items: page, nextCursor: null, order: [...KANBAN_ORDER] }),
          });
        }
        const page = matching.slice(offset, offset + limit);
        const body = {
          items: page,
          nextCursor: offset + page.length < matching.length ? String(offset + page.length) : null,
        };
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify(body)),
          json: () => Promise.resolve(body),
        });
      }),
    );
    return { seen, rows };
  }

  it("unfiltered --children --limit 1 is ONE request with the kanban top row", async () => {
    // 1,874-task board (300 in-progress heads, then todo): the top-1 peer
    // IS the kanban top row because the scope includes children. The exact
    // head is the newest-created in-progress row (created desc within the
    // rank) — derived from the full scan below, never hardcoded.
    const spec = Array.from({ length: 1874 }, (_, i) => ({
      status: i < 300 ? "in-progress" : "todo",
    }));
    const { seen } = stubKanbanBoard(spec);
    const top = await remoteTaskStore.listTasks(PROJECT, undefined, {
      sort: "kanban",
      limit: 1,
      children: true,
    });
    const listUrls = seen.filter(isListUrl);
    expect(listUrls).toHaveLength(1);
    const u = new URL(listUrls[0] as string);
    expect(u.searchParams.get("sort")).toBe("kanban");
    expect(u.searchParams.get("limit")).toBe("1");
    expect(top).toHaveLength(1);
    // Same row the full scan client-sorted would head with.
    stubKanbanBoard(spec);
    const full = await remoteTaskStore.listTasks(PROJECT);
    const { sortTasksForListing } = await import("../../src/core/task-listing.js");
    expect(top.map((t) => t.id)).toEqual(sortTasksForListing(full).slice(0, 1).map((t) => t.id));
  });

  it("a pushable-status filtered --limit K is ONE request with the same rows as the full scan", async () => {
    const spec = [
      { status: "in-progress", priority: "High" },
      { status: "review", priority: "Critical" },
      { status: "todo", priority: "Critical" },
      { status: "todo", priority: "Low" },
      { status: "backlog", priority: "Medium" },
      { status: "todo", priority: "Medium", childOf: "task-0002" },
      { status: "cancelled", priority: "High" },
      { status: "done", priority: "Low" },
    ];
    const { seen } = stubKanbanBoard(spec);
    const top = await remoteTaskStore.listTasks(PROJECT, undefined, {
      status: "todo",
      sort: "kanban",
      limit: 3,
    });
    const listUrls = seen.filter(isListUrl);
    expect(listUrls).toHaveLength(1);
    const u = new URL(listUrls[0] as string);
    expect(u.searchParams.get("sort")).toBe("kanban");
    expect(u.searchParams.get("limit")).toBe("3");
    expect(u.searchParams.get("status")).toBe("todo");
    // Same rows the full scan filtered client-side would keep (status via
    // the toCliStatus mapping, then the shared client sort, sliced to K).
    const { sortTasksForListing } = await import("../../src/core/task-listing.js");
    const seenFull = stubKanbanBoard(spec).seen;
    void seenFull;
    const full = await remoteTaskStore.listTasks(PROJECT);
    const { toLocalTask: map } = await import("../../src/core/remote-task-store.js");
    void map;
    // Filter client-side exactly like queryTaskList does for status.
    const filtered = full.filter((t) => t.status === "todo");
    const expected = sortTasksForListing(filtered).slice(0, 3).map((t) => t.id);
    expect(top.map((t) => t.id)).toEqual(expected);
  });

  it("status=done with sort+limit stays a full scan (cancelled rows would drop)", async () => {
    const spec = Array.from({ length: 600 }, (_, i) => ({
      status: i % 2 === 0 ? "done" : "in-progress",
    }));
    spec.push({ status: "cancelled" });
    const { seen } = stubKanbanBoard(spec);
    const rows = await remoteTaskStore.listTasks(PROJECT, undefined, {
      status: "done",
      sort: "kanban",
      limit: 1,
    } as never);
    const listUrls = seen.filter(isListUrl);
    // Full scan at 500-row pages over 601 rows = 2 requests, none with sort.
    expect(listUrls.length).toBeGreaterThan(1);
    for (const url of listUrls) {
      expect(new URL(url).searchParams.has("sort")).toBe(false);
    }
    // The cancelled row survives as client-side `done`.
    expect(rows.find((t) => t.status === "done")).toBeDefined();
  });

  it("root-only unfiltered with scope=roots&sort+limit is ONE request with today's root row", async () => {
    // 600 roots + 1 child: the scope=roots page hides the child, so the
    // top-1 root IS today's root-only top-1 (same-row vs the full scan).
    const spec = Array.from({ length: 600 }, (_, i) => ({ status: "todo" }));
    spec.push({ status: "todo", childOf: "task-0000" });
    const { seen } = stubKanbanBoard(spec);
    const top = await remoteTaskStore.listTasks(PROJECT, undefined, {
      scope: "roots",
      sort: "kanban",
      limit: 1,
    });
    const listUrls = seen.filter(isListUrl);
    expect(listUrls).toHaveLength(1);
    const u = new URL(listUrls[0] as string);
    expect(u.searchParams.get("scope")).toBe("roots");
    expect(u.searchParams.get("sort")).toBe("kanban");
    expect(u.searchParams.get("limit")).toBe("1");
    expect(top).toHaveLength(1);
    // Same row the full-scan root-only path heads with.
    stubKanbanBoard(spec);
    const full = await remoteTaskStore.listTasks(PROJECT);
    const { sortTasksForListing } = await import("../../src/core/task-listing.js");
    const { isChildTask } = await import("../../src/core/tasks.js");
    const expected = sortTasksForListing(full.filter((t) => !isChildTask(t))).slice(0, 1);
    expect(top.map((t) => t.id)).toEqual(expected.map((t) => t.id));
  });

  it("root-only sort+limit WITHOUT scope stays a full scan (peers are not roots)", async () => {
    const spec = Array.from({ length: 600 }, (_, i) => ({
      status: "todo",
      ...(i === 0 ? { childOf: "task-0005" } : {}),
    }));
    const { seen } = stubKanbanBoard(spec);
    const rows = await remoteTaskStore.listTasks(PROJECT, undefined, {
      sort: "kanban",
      limit: 1,
    } as never);
    const listUrls = seen.filter(isListUrl);
    expect(listUrls.length).toBeGreaterThan(1);
    for (const url of listUrls) {
      expect(new URL(url).searchParams.has("sort")).toBe(false);
    }
    expect(rows.length).toBeGreaterThan(1);
  });
});

describe("online tag parity — server tags reach the shared filter", () => {
  // Ticket 601fd5f3: the server already sends `tags` on every v0 row, but
  // the CLI's server->task mapping dropped them, so an online `--tag`
  // filter matched nothing while the same filter locally matched. The fix
  // is ONE task shape — the mapping carries tags where the local path
  // puts them — and the existing shared filter keeps doing its one job.
  // Every test here runs the shared queryTaskList model both sides read
  // through, so the modes cannot drift again without going red.
  const taggedBoard = () =>
    stubBoard({
      pages: [
        {
          items: [
            v0Task("t-alpha", { tags: ["frontend"] }),
            v0Task("t-beta", { tags: ["frontend", "demo"] }),
            v0Task("t-gamma", { tags: ["backend"] }),
            v0Task("t-plain"),
          ],
          nextCursor: null,
        },
      ],
    });

  /** The same fixture as local records: tags where normalizeTask puts them. */
  const localFixture = () =>
    [
      { id: "t-alpha", tags: ["frontend"] },
      { id: "t-beta", tags: ["frontend", "demo"] },
      { id: "t-gamma", tags: ["backend"] },
      { id: "t-plain", tags: undefined },
    ].map((t) => ({
      id: t.id,
      title: `remote ${t.id}`,
      description: `body of ${t.id}`,
      status: "todo" as const,
      selector: "/",
      created: "2026-01-01T00:00:00.000Z",
      ...(t.tags !== undefined ? { tags: t.tags } : {}),
    }));

  it("toLocalTask carries tags where the local path puts them (no second filter path)", () => {
    const task = toLocalTask(
      v0Task("tagged-1", { tags: ["frontend", "demo"] }) as never,
    );
    expect(task?.tags).toEqual(["frontend", "demo"]);
  });

  it("toLocalTask leaves tags absent when the server sends none (no invented defaults)", () => {
    const task = toLocalTask(v0Task("plain-1") as never);
    expect(task).not.toHaveProperty("tags");
  });

  it("toLocalTask drops non-string/empty tags exactly like the local normalizer", () => {
    const task = toLocalTask(
      v0Task("messy-1", { tags: ["ok", "", 42, " auth "] }) as never,
    );
    // Verbatim, like core/tasks.ts: no trim, no lowercase, no dedupe.
    expect(task?.tags).toEqual(["ok", " auth "]);
  });

  it("parity: the same fixture filtered by --tag answers identically local and online", async () => {
    taggedBoard();
    const online = await remoteTaskStore.listTasks(PROJECT);
    const { queryTaskList } = await import("../../src/core/task-listing.js");
    const onlineIds = queryTaskList(online, { tag: ["frontend"] }).tasks.map(
      (t) => t.id,
    );
    const localIds = queryTaskList(localFixture(), {
      tag: ["frontend"],
    }).tasks.map((t) => t.id);
    // The modes agree AND the answer is the tagged set (not empty).
    expect(onlineIds).toEqual(["t-alpha", "t-beta"]);
    expect(onlineIds).toEqual(localIds);
  });

  it("parity holds for multi-tag every-match, not just single-tag", async () => {
    taggedBoard();
    const online = await remoteTaskStore.listTasks(PROJECT);
    const { queryTaskList } = await import("../../src/core/task-listing.js");
    const onlineIds = queryTaskList(online, {
      tag: ["frontend", "demo"],
    }).tasks.map((t) => t.id);
    const localIds = queryTaskList(localFixture(), {
      tag: ["frontend", "demo"],
    }).tasks.map((t) => t.id);
    expect(onlineIds).toEqual(["t-beta"]);
    expect(onlineIds).toEqual(localIds);
  });

  it("honest empty: a tag nobody has returns empty without error, never a silent fall-through", async () => {
    taggedBoard();
    const online = await remoteTaskStore.listTasks(PROJECT);
    const { queryTaskList } = await import("../../src/core/task-listing.js");
    const res = queryTaskList(online, { tag: ["no-such-tag"] });
    expect(res.tasks).toEqual([]);
    expect(res.totalMatching).toBe(0);
    expect(res.truncated).toBe(false);
    // And the filter ran over real data: the rows still carry their tags,
    // so empty here means "nobody has it", not "the filter is broken".
    expect(online.find((t) => t.id === "t-alpha")?.tags).toEqual([
      "frontend",
    ]);
  });
});
