/**
 * Authoritative-read proof (ticket d7b9dc13, phantom record ref 38f085df).
 *
 * The failure mode: with a token present the CLI read the remote board while
 * local MCP read the local files, so a task could be visible in one surface
 * and absent in the other — and a stale local copy looked current.
 *
 * Every test here seeds a DISTINCT stale local sentinel the remote board
 * never names, then reads through the SAME operations the MCP tools call
 * with `mode: "saas"`:
 * - the sentinel must never be presented as current;
 * - the rows must equal what the CLI's online path (`fetchSaasTasks`, the
 *   function the `tasks` listing reads) returns for the same board;
 * - a dead backend must refuse, never serve the sentinel as a fallback.
 *
 * Mutation note: routing list/get back to `resolveOperationPorts` (local
 * always) returns the sentinel where remote rows are asserted → red.
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
import { listTasks, getTask } from "../../src/core/operations/tasks.js";
import { fetchSaasTasks } from "../../src/saas/client.js";
import { localTaskStore } from "../../src/core/task-store.js";
import type { OperationContext } from "../../src/core/operations.js";

const SENTINEL_TITLE = "STALE-LOCAL-SENTINEL-d7b9dc13";

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

/** Route the fake by URL: boards, detail, list. Returns every URL seen. */
function stubRemote(remoteIds: string[], seen: string[] = []): string[] {
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
      const detailMatch = url.match(/\/api\/v0\/tasks\/([^/?]+)$/);
      if (detailMatch) {
        const id = detailMatch[1];
        if (!remoteIds.includes(id)) {
          return Promise.resolve({
            ok: false, status: 404,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve("{}"),
            json: () => Promise.resolve({}),
          });
        }
        const body = v0Task(id);
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify(body)),
          json: () => Promise.resolve(body),
        });
      }
      const page = { items: remoteIds.map((id) => v0Task(id)), nextCursor: null };
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => "application/json" },
        text: () => Promise.resolve(JSON.stringify(page)),
        json: () => Promise.resolve(page),
      });
    }),
  );
  return seen;
}

async function seedSentinel(): Promise<{ projectDir: string; sentinelId: string }> {
  const projectDir = mkdtempSync(join(tmpdir(), "authoritative-read-"));
  const created = await localTaskStore.createTask(projectDir, {
    title: SENTINEL_TITLE,
    description: "a stale local copy the remote board never names",
    status: "todo",
    selector: "/",
    author: "sentinel-author",
  } as never);
  return { projectDir, sentinelId: created.id };
}

beforeEach(() => {
  vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
  vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saas-mode operations read the remote board, never the stale local copy", () => {
  it("list_tasks returns the remote rows; the sentinel is absent", async () => {
    const { projectDir } = await seedSentinel();
    const seen = stubRemote(["remote-1", "remote-2"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };

    const result = await listTasks(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const titles = result.data.tasks.map((t) => t.title);
    expect(titles).toEqual(["remote remote-1", "remote remote-2"]);
    expect(JSON.stringify(result.data)).not.toContain(SENTINEL_TITLE);
    expect(seen.some((u) => u.includes("/api/v0/tasks"))).toBe(true);
  });

  it("get_task reads the remote detail without enumerating the board", async () => {
    const { projectDir } = await seedSentinel();
    const seen = stubRemote(["remote-7"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };

    const result = await getTask(ctx, { id: "remote-7" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.title).toBe("remote remote-7");
    // Detail for resolution + detail for relations; zero board listings.
    expect(seen.filter((u) => /\/api\/v0\/tasks\/[^/]+$/.test(u)).length).toBeGreaterThan(0);
    expect(seen.filter((u) => /\/api\/v0\/tasks(\?|$)/.test(u))).toHaveLength(0);
  });

  it("CLI and MCP return the SAME source of truth for the same mode", async () => {
    const { projectDir } = await seedSentinel();
    stubRemote(["remote-1", "remote-2"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };

    // The MCP surface: the shared operation.
    const opResult = await listTasks(ctx, {});
    expect(opResult.ok).toBe(true);
    if (!opResult.ok) return;

    // The CLI online path: the `tasks` listing reads this function.
    const cliResult = await fetchSaasTasks("board-1", { hydrate: false });
    expect(cliResult.ok).toBe(true);
    if (!cliResult.ok) return;

    expect(opResult.data.tasks.map((t) => t.id).sort()).toEqual(
      cliResult.data.tasks.map((t) => t.id).sort(),
    );
  });

  it("a dead backend refuses — the sentinel is never served as a fallback", async () => {
    const { projectDir } = await seedSentinel();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    const ctx: OperationContext = { projectDir, mode: "saas" };

    const result = await listTasks(ctx, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_BACKEND_UNAVAILABLE");
    // No data arm exists on a refusal — there is nowhere for the sentinel
    // to hide. The local copy stays unread.
    expect("data" in result ? result.data : undefined).toBeUndefined();
  });

  it("control: local mode still reads the sentinel (the fixture is real)", async () => {
    const { projectDir } = await seedSentinel();
    const ctx: OperationContext = { projectDir, mode: "local" };
    const result = await listTasks(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tasks.map((t) => t.title)).toContain(SENTINEL_TITLE);
  });
});
