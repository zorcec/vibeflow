/**
 * Operations top-K forwarding (ticket 05076246): `listTasks` offers
 * `sort: "kanban"` + `limit` to the remote store ONLY where the server's
 * scope matches the client's.
 *
 * - unfiltered `--children` + limit → forwarded (`?sort=kanban&limit=K`,
 *   ONE request);
 * - pushable-status filtered + limit → forwarded (a filtered search
 *   includes children by contract, so peer scope matches);
 * - type/user/tag filters → NEVER forwarded (v0 has no server param for
 *   them; a narrowed fetch could miss a row the client-side filter keeps);
 * - root-only default (no `--children`, no status filter) → forwarded as
 *   `scope=roots&sort=kanban&limit=K` (LANE Z: ROOTS_ONLY_COND is the server
 *   image of the root-only filter, page + COUNT share the predicate);
 *
 * The adapter re-validates the same conditions and falls back to the full
 * scan if any fail there too — these tests pin the operations side of
 * that contract by asserting on the wire (the `sort` query param).
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
import { listTasks } from "../../src/core/operations/tasks.js";
import type { OperationContext } from "../../src/core/operations.js";

function v0Task(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `remote ${id}`,
    description: `body of ${id}`,
    status: "todo",
    priority: null,
    type: "Task",
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

/** List stub: boards + one kanban-echoing page + detail 404s. */
function stubList(ids: string[], seen: string[] = []): string[] {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      seen.push(url);
      if (url.includes("/api/v0/boards")) {
        const payload = { items: [{ id: "board-1", name: "B1" }], nextCursor: null };
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify(payload)),
          json: () => Promise.resolve(payload),
        });
      }
      if (/\/api\/v0\/tasks\/[^/?]+($|\/)/.test(url) && !/\/api\/v0\/tasks(\?|$)/.test(url)) {
        return Promise.resolve({
          ok: false, status: 404,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve("{}"),
          json: () => Promise.resolve({}),
        });
      }
      const u = new URL(url);
      const sort = u.searchParams.get("sort");
      const limit = Number(u.searchParams.get("limit") ?? "500");
      const status = u.searchParams.get("status");
      const matching = ids.filter((id) => status === null || id.startsWith(`${status}-`));
      const page = matching.slice(0, Number.isFinite(limit) ? limit : matching.length);
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => "application/json" },
        text: () => Promise.resolve(JSON.stringify({ items: page.map((id) => v0Task(id)), nextCursor: null })),
        json: () =>
          Promise.resolve({
            items: page.map((id) => v0Task(id)),
            nextCursor: null,
            ...(sort === "kanban"
              ? { order: ["status:asc", "priority:asc", "created:desc", "id:asc"] }
              : {}),
          }),
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

describe("operations listTasks top-K forwarding (05076246)", () => {
  it("unfiltered --children + limit forwards sort=kanban (ONE request)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "op-topk-"));
    const seen = stubList(["todo-a", "todo-b", "review-c"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };
    const result = await listTasks(ctx, { children: true, limit: 2 });
    expect(result.ok).toBe(true);
    const listUrls = seen.filter(isListUrl);
    expect(listUrls).toHaveLength(1);
    expect(new URL(listUrls[0] as string).searchParams.get("sort")).toBe("kanban");
    expect(new URL(listUrls[0] as string).searchParams.get("limit")).toBe("2");
    if (!result.ok) return;
    expect(result.data.tasks).toHaveLength(2);
  });

  it("a pushable-status filter + limit forwards sort=kanban", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "op-topk-"));
    const seen = stubList(["todo-a", "todo-b", "review-c"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };
    const result = await listTasks(ctx, { status: "todo", limit: 1 });
    expect(result.ok).toBe(true);
    const listUrls = seen.filter(isListUrl);
    expect(listUrls).toHaveLength(1);
    const u = new URL(listUrls[0] as string);
    expect(u.searchParams.get("sort")).toBe("kanban");
    expect(u.searchParams.get("status")).toBe("todo");
    // A filtered search includes children by contract — scope=roots must
    // never narrow it (matching children would silently drop).
    expect(u.searchParams.has("scope")).toBe(false);
    if (!result.ok) return;
    expect(result.data.tasks.map((t) => t.id)).toEqual(["todo-a"]);
  });

  it("a type filter never forwards sort (FULL SCAN — no server param)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "op-topk-"));
    const seen = stubList(["todo-a", "todo-b"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };
    const result = await listTasks(ctx, { type: "Bug", children: true, limit: 1 });
    expect(result.ok).toBe(true);
    for (const url of seen.filter(isListUrl)) {
      expect(new URL(url).searchParams.has("sort")).toBe(false);
    }
  });

  it("the root-only default forwards scope=roots&sort (ONE request, today's row)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "op-topk-"));
    const seen = stubList(["todo-a", "todo-b"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };
    const result = await listTasks(ctx, { limit: 1 });
    expect(result.ok).toBe(true);
    const listUrls = seen.filter(isListUrl);
    expect(listUrls).toHaveLength(1);
    const u = new URL(listUrls[0] as string);
    expect(u.searchParams.get("scope")).toBe("roots");
    expect(u.searchParams.get("sort")).toBe("kanban");
    expect(u.searchParams.get("limit")).toBe("1");
    expect(u.searchParams.has("status")).toBe(false);
  });

  it("--status done never forwards sort (cancelled rows would drop)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "op-topk-"));
    const seen = stubList(["done-a", "done-b"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };
    const result = await listTasks(ctx, { status: "done", limit: 1 });
    expect(result.ok).toBe(true);
    for (const url of seen.filter(isListUrl)) {
      expect(new URL(url).searchParams.has("sort")).toBe(false);
    }
  });
});
