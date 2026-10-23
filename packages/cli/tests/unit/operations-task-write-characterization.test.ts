/**
 * Write-path characterization (ticket efcd6992, P4 step 1).
 *
 * Pins TODAY's observable behaviour of the three task-write operations in
 * `mode: "saas"` — the divergence P4 exists to remove:
 *
 * - the existence check (`resolveTaskOrRefusal`) already reads the
 *   AUTHORITATIVE store (remote in saas mode, via `resolveReadPorts`);
 * - the WRITE itself still resolves through `resolveOperationPorts`, which
 *   is the local file adapter unless a store was explicitly injected.
 *
 * So a saas-mode MCP write today reads one backend and writes another:
 * create lands a local file with zero remote traffic; update of a
 * remote-only id resolves remotely then misses locally; comment on a
 * remote id resolves remotely then mints a LOCAL ghost stub (the ghost
 * the local path's resolver was added to prevent) while the remote board
 * sees no POST.
 *
 * Each test carries a flip note naming the P4 change that must turn it
 * red: routing the three writes through the mode-aware write ports
 * (`resolveWritePorts`) so a saas-mode write POSTs/PATCHes the board it
 * resolved against and writes no local file on either success or refusal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync, readFileSync } from "node:fs";
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
  createTask,
  updateTask,
  addComment,
  type OperationContext,
} from "../../src/core/operations.js";

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
    // Inlined (like the e2e fakes) so the detail read issues no
    // hydration sub-requests for comments/files.
    comments: [],
    files: [],
    ...extra,
  };
}

/** Stub the remote board; return every request the operation layer makes. */
function stubRemote(remoteIds: string[]): Array<{ method: string; url: string }> {
  const seen: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
      seen.push({ method: (init?.method ?? "GET").toUpperCase(), url });
      if (url.includes("/api/v0/boards")) {
        const payload = {
          items: [{ id: "board-1", name: "B1" }],
          nextCursor: null,
        };
        return Promise.resolve({
          ok: true,
          status: 200,
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
            ok: false,
            status: 404,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve("{}"),
            json: () => Promise.resolve({}),
          });
        }
        const body = v0Task(id);
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify(body)),
          json: () => Promise.resolve(body),
        });
      }
      const page = {
        items: remoteIds.map((id) => v0Task(id)),
        nextCursor: null,
      };
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

function localTaskFiles(projectDir: string): string[] {
  const dir = join(projectDir, ".vibeflow", "tasks");
  if (!existsSync(dir)) return [];
  // Task records only — `.locks/` holds lockfiles, not tasks.
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) =>
    f.endsWith(".json"),
  );
}

beforeEach(() => {
  vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
  vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saas-mode write operations still land locally (P4 divergence)", () => {
  it("createTask in saas mode writes a LOCAL file and issues zero remote writes", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "write-char-"));
    const seen = stubRemote(["remote-1"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };

    // FLIP NOTE (efcd6992 step 2): routing creates through the write ports
    // must turn this red — the op must POST the remote board and leave the
    // local store empty.
    const result = await createTask(ctx, {
      title: "saas create today",
      status: "todo",
      selector: "/",
    } as never);
    expect(result.ok).toBe(true);

    const writes = seen.filter((r) => !r.url.includes("/api/v0/boards"));
    expect(
      writes,
      `saas create must not touch the remote board today (saw ${writes.map((r) => `${r.method} ${r.url}`).join(", ")})`,
    ).toEqual([]);
    expect(localTaskFiles(projectDir).length).toBeGreaterThan(0);
  });

  it("updateTask of a remote-only id resolves remotely then misses locally, with zero remote PATCHes", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "write-char-"));
    const seen = stubRemote(["remote-1"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };

    // FLIP NOTE (efcd6992 step 2): the same call must PATCH the remote
    // board once and answer ok:true; the local store must stay empty.
    const result = await updateTask(ctx, {
      id: "remote-1",
      title: "renamed",
    } as never);
    expect(result.ok).toBe(false);
    const mutating = seen.filter(
      (r) => r.method !== "GET" && !r.url.includes("/api/v0/boards"),
    );
    expect(
      mutating,
      `saas update must issue zero remote writes today (saw ${mutating.map((r) => `${r.method} ${r.url}`).join(", ")})`,
    ).toEqual([]);
    expect(localTaskFiles(projectDir)).toEqual([]);
  });

  it("addComment on a remote id resolves remotely then mints a LOCAL ghost stub, with zero remote POSTs", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "write-char-"));
    const seen = stubRemote(["remote-1"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };

    // FLIP NOTE (efcd6992 step 2): the comment must POST to the remote
    // board once and mint no local file of any kind.
    const result = await addComment(ctx, {
      id: "remote-1",
      author: "agent",
      comment: "a note for the remote board",
    } as never);
    expect(result.ok).toBe(true);

    const posts = seen.filter(
      (r) => r.method !== "GET" && !r.url.includes("/api/v0/boards"),
    );
    expect(posts).toEqual([]);
    const files = localTaskFiles(projectDir);
    expect(files.length).toBeGreaterThan(0);
    const ghost = JSON.parse(
      readFileSync(join(projectDir, ".vibeflow", "tasks", files[0]), "utf-8"),
    ) as { id: string; title?: string; comments: Array<{ text: string }> };
    expect(ghost.id).toBe("remote-1");
    expect(ghost.title).toBeUndefined();
    expect(ghost.comments.map((c) => c.text)).toEqual([
      "a note for the remote board",
    ]);
  });
});
