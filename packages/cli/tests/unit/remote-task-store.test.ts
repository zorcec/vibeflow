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
  it("every mutating method except the claim throws REMOTE_WRITE_NOT_ROUTED", async () => {
    // P3 (ticket 6452504d): the claim IS routed here now — it is the one
    // remote mutation with a truthful contract. Everything else still
    // refuses loudly until P4.
    stubBoard({});
    await expect(remoteTaskStore.createTask(PROJECT, {} as never)).rejects.toBeInstanceOf(RemoteWriteNotRoutedError);
    await expect(remoteTaskStore.updateTask(PROJECT, "x", {})).rejects.toBeInstanceOf(RemoteWriteNotRoutedError);
    await expect(remoteTaskStore.deleteTask(PROJECT, "x")).rejects.toBeInstanceOf(RemoteWriteNotRoutedError);
    await expect(remoteTaskStore.addComment(PROJECT, "x", "agent", "hi")).rejects.toBeInstanceOf(RemoteWriteNotRoutedError);
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
