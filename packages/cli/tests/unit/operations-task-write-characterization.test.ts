/**
 * Write-path characterization (ticket efcd6992, P4 steps 1–2).
 *
 * Pins the AUTHORITATIVE behaviour of the three task-write operations in
 * `mode: "saas"` — the divergence step 1 characterized and step 2
 * removed:
 *
 * - the existence check (`resolveTaskOrRefusal`) reads the AUTHORITATIVE
 *   store (remote in saas mode, via `resolveReadPorts`);
 * - the WRITE itself resolves through the mode-aware write ports
 *   (`resolveWritePorts`) — the remote adapter in saas mode — so a
 *   saas-mode write POSTs/PATCHes the board it resolved against.
 *
 * Each test proves exactly ONE remote write with the awaited durable
 * response and an empty local store on success: create POSTs once (and
 * sends no `author` member — identity is server-stamped); update of a
 * remote id PATCHes once; comment POSTs once. No local file is minted on
 * either success or refusal, and the ghost-stub path is gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/auth/project-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/project-auth.js")>();
  return { ...actual, resolveProjectAuth: vi.fn() };
});
vi.mock("../../src/auth/project-pointer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/project-pointer.js")>();
  return { ...actual, readProjectPointer: vi.fn() };
});

import { resolveProjectAuth } from "../../src/auth/project-auth.js";
import { readProjectPointer } from "../../src/auth/project-pointer.js";
import { saasAuth, localAuth, TEST_API_URL } from "./helpers/mock-project-auth.js";
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

/**
 * Stub the remote board; return every request the operation layer makes.
 *
 * The stub speaks the mutating routes too (POST collection, PATCH detail,
 * POST comments) so the suite proves each write is exactly ONE remote
 * request with the awaited durable response — a write that never reaches
 * the fake fails here, and a write that reaches it twice fails the counts.
 */
function stubRemote(
  remoteIds: string[],
): Array<{ method: string; url: string; body: string }> {
  const seen: Array<{ method: string; url: string; body: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      (url: string, init?: { method?: string; body?: unknown }) => {
        const method = (init?.method ?? "GET").toUpperCase();
        const body = typeof init?.body === "string" ? init.body : "";
        seen.push({ method, url, body });
        const pathname = url.split("?")[0] as string;
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
        const detailMatch = pathname.match(/\/api\/v0\/tasks\/([^/]+)$/);
        const commentMatch = pathname.match(
          /\/api\/v0\/tasks\/([^/]+)\/comments$/,
        );
        if (method === "POST" && pathname.endsWith("/api/v0/tasks")) {
          const parsed = (body ? JSON.parse(body) : {}) as Record<
            string,
            unknown
          >;
          const id =
            typeof parsed.id === "string" && parsed.id.length > 0
              ? parsed.id
              : "server-minted-id";
          const row = v0Task(id, { ...parsed, id });
          return Promise.resolve({
            ok: true,
            status: 201,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve(JSON.stringify(row)),
            json: () => Promise.resolve(row),
          });
        }
        if (method === "PATCH" && detailMatch) {
          const id = detailMatch[1] as string;
          if (!remoteIds.includes(id)) {
            return Promise.resolve({
              ok: false,
              status: 404,
              headers: { get: () => "application/json" },
              text: () => Promise.resolve("{}"),
              json: () => Promise.resolve({}),
            });
          }
          const parsed = (body ? JSON.parse(body) : {}) as Record<
            string,
            unknown
          >;
          const row = { ...v0Task(id), ...parsed };
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve(JSON.stringify(row)),
            json: () => Promise.resolve(row),
          });
        }
        if (method === "POST" && commentMatch) {
          const parsed = (body ? JSON.parse(body) : {}) as Record<
            string,
            unknown
          >;
          const row = {
            id: "comment-1",
            text: typeof parsed.text === "string" ? parsed.text : "",
            createdAt: "2026-01-01T00:00:00.000Z",
          };
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve(JSON.stringify(row)),
            json: () => Promise.resolve(row),
          });
        }
        if (method === "GET" && detailMatch) {
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
          const detail = v0Task(id);
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve(JSON.stringify(detail)),
            json: () => Promise.resolve(detail),
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
      },
    ),
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
  vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
  vi.mocked(readProjectPointer).mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saas-mode writes are authoritative remote writes (P4, efcd6992)", () => {
  it("createTask in saas mode POSTs the remote board once and writes no local file", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "write-char-"));
    const seen = stubRemote(["remote-1"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };

    // efcd6992 step 2 (was the FLIP NOTE): creates resolve through the
    // write ports — one POST against the board the read resolved, and an
    // empty local store on success. The returned task is the server view
    // (identity is server-stamped: no `author` member rides the POST).
    const result = await createTask(ctx, {
      title: "saas create",
      status: "todo",
      selector: "/",
    } as never);
    expect(result.ok).toBe(true);

    const posts = seen.filter(
      (r) => r.method === "POST" && r.url.endsWith("/api/v0/tasks"),
    );
    expect(posts).toHaveLength(1);
    const sent = JSON.parse(posts[0].body) as Record<string, unknown>;
    expect(sent.title).toBe("saas create");
    expect(sent).not.toHaveProperty("author");
    expect(result.data?.title).toBe("saas create");
    expect(localTaskFiles(projectDir)).toEqual([]);
  });

  it("updateTask of a remote id PATCHes the remote board once and writes no local file", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "write-char-"));
    const seen = stubRemote(["remote-1"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };

    // efcd6992 step 2 (was the FLIP NOTE): the same call PATCHes the
    // remote board once and answers ok:true; the local store stays empty.
    const result = await updateTask(ctx, {
      id: "remote-1",
      title: "renamed",
    } as never);
    expect(result.ok).toBe(true);
    expect(result.data?.title).toBe("renamed");
    const patches = seen.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0].body)).toMatchObject({
      title: "renamed",
    });
    expect(localTaskFiles(projectDir)).toEqual([]);
  });

  it("addComment on a remote id POSTs the remote comment once and mints no local file", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "write-char-"));
    const seen = stubRemote(["remote-1"]);
    const ctx: OperationContext = { projectDir, mode: "saas" };

    // efcd6992 step 2 (was the FLIP NOTE): the comment POSTs to the
    // remote board once — awaited before success is reported — and mints
    // no local file of any kind (the ghost-stub path is gone).
    const result = await addComment(ctx, {
      id: "remote-1",
      author: "agent",
      comment: "a note for the remote board",
    } as never);
    expect(result.ok).toBe(true);
    expect(result.data?.text).toBe("a note for the remote board");

    const posts = seen.filter(
      (r) => r.method === "POST" && r.url.endsWith("/comments"),
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body)).toMatchObject({
      text: "a note for the remote board",
    });
    expect(localTaskFiles(projectDir)).toEqual([]);
  });
});
