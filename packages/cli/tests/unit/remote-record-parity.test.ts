/**
 * Parity proof, ticket 38f085df: MCP list/get and the CLI-online read apply
 * the SAME record schema and the SAME >20,000-character description
 * quarantine, and local ghost rows never surface on either.
 *
 * The board fixture carries roots, a child, a valid description of exactly
 * 20,000 chars (boundary), an invalid 20,001-char row, and an invalid-status
 * row the display mapper would silently coerce to `todo`. A stale local
 * sentinel (plus a quarantined local ghost) proves neither surface reads
 * local files in saas mode. A poisoned top-K page proves the full-scan
 * fallback keeps valid rows below the page.
 *
 * Mutation note: skipping validation in `validateSaasRows` (return every
 * mapped row) turns the quarantine assertions red — the bad ids appear on
 * both surfaces and the notice vanishes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/auth/project-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/project-auth.js")>();
  return {
    ...actual,
    resolveProjectAuth: vi.fn(),
    resolveProjectAuthCached: vi.fn(),
  };
});

import {
  resolveProjectAuth,
  resolveProjectAuthCached,
} from "../../src/auth/project-auth.js";
import { saasAuth } from "./helpers/mock-project-auth.js";
import { listTasks, getTask } from "../../src/core/operations/tasks.js";
import {
  invokeManifestTool,
  type McpSessionState,
} from "../../src/mcp/server.js";
import { manifest } from "../../src/mcp/manifest.js";
import { localTaskStore } from "../../src/core/task-store.js";
import type { OperationContext } from "../../src/core/operations.js";

const AT_CAP = "d".repeat(20_000);
const OVER_CAP = "d".repeat(20_001);

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

/** Fixed board: two valid roots, one child, two quarantined rows. */
function boardRows() {
  return [
    v0Task("par-root-a"),
    v0Task("par-root-b", { description: AT_CAP }),
    v0Task("par-child-c", { links: [{ taskId: "par-root-a", type: "parent" }] }),
    v0Task("par-bad-long", { description: OVER_CAP }),
    v0Task("par-bad-status", { status: "exploding" }),
  ];
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

/**
 * Fake v0: boards listing, detail by id (404 when absent), list with
 * server top-K semantics — a `limit` param answers the FIRST page only
 * (poisoned: the quarantined long row leads), otherwise the full board.
 * Records every URL seen.
 */
function stubParityBoard(seen: string[]) {
  const rows = boardRows();
  const byId = new Map(rows.map((r) => [r.id, r]));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      seen.push(url);
      if (url.includes("/api/v0/boards")) {
        return jsonResponse({
          items: [{ id: "board-1", name: "B1" }],
          nextCursor: null,
        });
      }
      const detailMatch = url.match(/\/api\/v0\/tasks\/([^/?]+)$/);
      if (detailMatch) {
        const row = byId.get(detailMatch[1] as string);
        if (!row) return jsonResponse({}, 404);
        return jsonResponse(row);
      }
      if (/\/api\/v0\/tasks(\?|$)/.test(url)) {
        const u = new URL(url);
        // Server top-K page (`sort=kanban&limit=K`): the invalid row
        // leads, so a client that trusts the page would lose valid rows
        // below it. Full scans also carry a paging `limit` (without
        // `sort`), so only the kanban-sorted request is poisoned.
        if (u.searchParams.get("sort") === "kanban") {
          return jsonResponse({
            items: [byId.get("par-bad-long"), byId.get("par-root-a")],
            nextCursor: null,
          });
        }
        const status = u.searchParams.get("status");
        const matching = rows.filter(
          (r) => status === null || (r.status as string) === status,
        );
        return jsonResponse({ items: matching, nextCursor: null });
      }
      return jsonResponse({}, 404);
    }),
  );
}

async function seedLocalGhosts(): Promise<{
  projectDir: string;
  sentinelId: string;
}> {
  const projectDir = mkdtempSync(join(tmpdir(), "remote-parity-"));
  const sentinel = await localTaskStore.createTask(projectDir, {
    title: "GHOST-SENTINEL-38f085df",
    description: "a stale local copy the remote board never names",
    status: "todo",
    selector: "/",
    author: "sentinel-author",
  } as never);
  // A quarantined local ghost: must not leak onto EITHER surface either.
  writeFileSync(
    join(projectDir, ".vibeflow", "tasks", "ghost-quarantined.json"),
    JSON.stringify({
      id: "ghost-quarantined",
      title: "ghost with overlong description",
      description: OVER_CAP,
      status: "todo",
      created: "2026-01-01T00:00:00.000Z",
    }),
  );
  return { projectDir, sentinelId: sentinel.id };
}

beforeEach(() => {
  // Both surfaces steer through the same saas auth: operations use the
  // direct resolver, the MCP session dispatch uses the mtime-checked
  // cache (which calls the module-local resolver, not the mock above).
  vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
  vi.mocked(resolveProjectAuthCached).mockResolvedValue(saasAuth());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mcpTools() {
  return {
    list: manifest.find((t) => t.name === "list_tasks")!,
    get: manifest.find((t) => t.name === "get_task")!,
  };
}

describe("38f085df: MCP and CLI-online serve the same validated board", () => {
  it("same id set on both surfaces; boundary row kept, quarantined + ghosts excluded, notice names them", async () => {
    const { projectDir, sentinelId } = await seedLocalGhosts();
    const seen: string[] = [];
    stubParityBoard(seen);
    const ctx: OperationContext = { projectDir, mode: "saas" };
    const { list } = mcpTools();
    const session: McpSessionState = {};
    const textOf = (res: Awaited<ReturnType<typeof invokeManifestTool>>) =>
      JSON.parse((res.content[0] as { text: string }).text) as {
        tasks: Array<{ id: string }>;
      };

    const mcpList = textOf(await invokeManifestTool(list, ctx, {}, session));
    const mcpIds = mcpList.tasks.map((t) => t.id).sort();

    const cli = await listTasks(ctx, {});
    expect(cli.ok).toBe(true);
    if (!cli.ok) return;
    const cliIds = cli.data.tasks.map((t) => t.id).sort();

    // Default scope is roots-only: the child is a real board row but not a root.
    expect(cliIds).toEqual(["par-root-a", "par-root-b"]);
    expect(mcpIds).toEqual(cliIds);
    // The exactly-20,000 boundary row survives on both.
    expect(cli.data.tasks.find((t) => t.id === "par-root-b")?.description).toHaveLength(20_000);

    // Quarantined rows are excluded from the TASKS on both surfaces — but
    // named in the quarantine notice (asserted below), so check id lists,
    // not whole-envelope text.
    for (const tasks of [mcpList.tasks, cli.data.tasks]) {
      const ids = tasks.map((t) => t.id);
      expect(ids).not.toContain("par-bad-long");
      expect(ids).not.toContain("par-bad-status");
      expect(ids).not.toContain(sentinelId);
      expect(ids).not.toContain("ghost-quarantined");
    }
    for (const blob of [JSON.stringify(mcpList), JSON.stringify(cli.data)]) {
      expect(blob).not.toContain("GHOST-SENTINEL-38f085df");
    }

    // The quarantine notice names both bad rows (CLI surface carries steps).
    const steps = "steps" in cli && Array.isArray(cli.steps) ? cli.steps : [];
    const quarantine = steps.find(
      (s) => typeof s === "object" && s !== null && "code" in s && (s as { code: string }).code === "TASK_RECORD_QUARANTINED",
    ) as { message: string } | undefined;
    expect(quarantine).toBeDefined();
    expect(quarantine?.message).toContain("par-bad-long");
    expect(quarantine?.message).toContain("par-bad-status");
  });

  it("child-inclusive scope agrees too, with the child resolved to its root", async () => {
    const { projectDir } = await seedLocalGhosts();
    stubParityBoard([]);
    const ctx: OperationContext = { projectDir, mode: "saas" };
    const { list } = mcpTools();
    const session: McpSessionState = {};
    const textOf = (res: Awaited<ReturnType<typeof invokeManifestTool>>) =>
      JSON.parse((res.content[0] as { text: string }).text) as {
        tasks: Array<{ id: string }>;
      };

    const mcpList = textOf(
      await invokeManifestTool(list, ctx, { children: true }, session),
    );
    const cli = await listTasks(ctx, { children: true });
    expect(cli.ok).toBe(true);
    if (!cli.ok) return;
    expect(mcpList.tasks.map((t) => t.id).sort()).toEqual(
      cli.data.tasks.map((t) => t.id).sort(),
    );
    expect(cli.data.tasks.map((t) => t.id).sort()).toEqual([
      "par-child-c",
      "par-root-a",
      "par-root-b",
    ]);
  });

  it("get agrees: valid id and unique prefix found, overlong detail refused, ghost missing", async () => {
    const { projectDir, sentinelId } = await seedLocalGhosts();
    stubParityBoard([]);
    const ctx: OperationContext = { projectDir, mode: "saas" };
    const { get } = mcpTools();
    const session: McpSessionState = {};
    const textOf = (res: Awaited<ReturnType<typeof invokeManifestTool>>) =>
      JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;

    const cliGet = await getTask(ctx, { id: "par-root-a" });
    expect(cliGet.ok).toBe(true);
    const mcpGet = textOf(await invokeManifestTool(get, ctx, { id: "par-root-a" }, session));
    expect(mcpGet["title"]).toBe("remote par-root-a");

    // Unique prefix resolves to the child on both surfaces.
    const cliPrefix = await getTask(ctx, { id: "par-child" });
    expect(cliPrefix.ok).toBe(true);
    const mcpPrefix = textOf(
      await invokeManifestTool(get, ctx, { id: "par-child" }, session),
    );
    expect(mcpPrefix["id"]).toBe("par-child-c");

    // The overlong row refuses — never its truncated description, never a
    // stale local copy. The operation seam reports it unreadable, exactly
    // like a quarantined local file.
    const cliBad = await getTask(ctx, { id: "par-bad-long" });
    expect(cliBad.ok).toBe(false);
    if (cliBad.ok) return;
    expect(cliBad.error.code).toBe("TASK_READ_ERROR");
    const mcpBad = textOf(
      await invokeManifestTool(get, ctx, { id: "par-bad-long" }, session),
    );
    expect(mcpBad["ok"]).toBe(false);
    expect(
      JSON.stringify(mcpBad).includes("TASK_READ_ERROR") ||
        JSON.stringify(mcpBad).includes("does not parse"),
    ).toBe(true);

    // The local ghost is missing on the board — on both surfaces.
    const cliGhost = await getTask(ctx, { id: sentinelId });
    expect(cliGhost.ok).toBe(false);
    const mcpGhost = textOf(
      await invokeManifestTool(get, ctx, { id: sentinelId }, session),
    ) as { ok: boolean; error?: { code: string } };
    expect(mcpGhost.ok).toBe(false);
    expect(mcpGhost.error?.code).toBe("TASK_NOT_FOUND");
  });

  it("a poisoned top-K page falls back to the full scan (valid rows below the page survive)", async () => {
    const { projectDir } = await seedLocalGhosts();
    const seen: string[] = [];
    stubParityBoard(seen);
    const ctx: OperationContext = { projectDir, mode: "saas" };

    // Unfiltered roots-only + limit → one top-K request whose page leads
    // with the quarantined row. Without the fallback the answer would be a
    // single valid task; with it, the full valid set pages normally.
    const cli = await listTasks(ctx, { limit: 2 });
    expect(cli.ok).toBe(true);
    if (!cli.ok) return;
    expect(cli.data.tasks).toHaveLength(2);
    for (const t of cli.data.tasks) {
      expect(["par-root-a", "par-root-b"]).toContain(t.id);
    }
    // Proof the fallback fired: a full-scan list request (paged `limit`
    // but no `sort=kanban` top-K) went out after the poisoned page.
    const listUrls = seen.filter((u) => /\/api\/v0\/tasks(\?|$)/.test(u));
    expect(listUrls.length).toBeGreaterThan(1);
    expect(listUrls.some((u) => !new URL(u).searchParams.has("sort"))).toBe(true);
  });
});
