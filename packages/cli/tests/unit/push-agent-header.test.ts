/**
 * `X-Vibeflow-Agent` on every bulk-push write surface (ticket uge57p8j).
 *
 * The echo filter (ticket kzxaq0fd) only works if the write that CAUSED an
 * event names its agent. Ordinary task writes did; the bulk paths did not —
 * `vibeflow push`, the tree import, the delta archive, file uploads and the
 * board's `POST /api/push` all carried no `agent`, so a follower was handed
 * back its own push (the b7dvqr7z bug, one transport over).
 *
 * These tests pin BOTH halves on every surface: an identity present → the
 * header names it; no identity → NO header at all. The second half is the
 * load-bearing one: an empty or placeholder value would be compared against a
 * follower's identity and could silence an event nobody can attribute.
 *
 * The surfaces keep building their own Authorization/scope headers (they are
 * not on `getBearerHeaders`), so each assertion names the exact request method
 * + path — a header on the wrong request would not satisfy them.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPushLinks, createTasksOneByOne } from "../../src/auth/login.js";
import {
  importBatchTree,
  type ImportTaskInput,
} from "../../src/saas/batch-push.js";
import { sendDeltaArchive } from "../../src/saas/delta-push.js";
import { uploadTaskFiles } from "../../src/commands/push.js";
import { isOwnNotification } from "../../src/core/notifications.js";
import * as filesModule from "../../src/core/files.js";

// `uploadTaskFiles` reads its job list from the task record; the file bytes on
// disk are real (the upload path reads them), so only the listing is stubbed.
vi.mock("../../src/core/files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/files.js")>();
  return { ...actual, listFiles: vi.fn() };
});

const API = "https://x.test";
const TOKEN = "tok";
const BOARD = "board-9";
/** The identity the pi harness would derive — pinned, not derived (see setup). */
const ACTOR = "pi-push-test";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Identity present: the explicit actor wins over the suite's off switch. */
function withIdentity(): void {
  vi.stubEnv("VIBEFLOW_ACTOR", ACTOR);
}

/** Identity absent: no actor AND the derivation switched off. */
function withoutIdentity(): void {
  vi.stubEnv("VIBEFLOW_ACTOR", "");
  vi.stubEnv("VIBEFLOW_AGENT_IDENTITY", "off");
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Scripted transport: records what each request actually carried and answers
 * `replyFor(url)`. The surfaces read `.ok`/`.json()`, so a plain object is
 * enough — nothing here bypasses a real header-building path.
 */
function stubFetch(replyFor: (url: string) => unknown): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body,
      });
      return {
        ok: true,
        status: 200,
        json: async () => replyFor(url),
        text: async () => "",
        headers: { get: () => null },
      };
    }),
  );
  return calls;
}

const agentOn = (call: Recorded): string | undefined =>
  call.headers["X-Vibeflow-Agent"];
const find = (calls: Recorded[], method: string, path: string): Recorded => {
  const call = calls.find((c) => c.method === method && c.url.endsWith(path));
  expect(call, `no ${method} ${path} in ${calls.map((c) => `${c.method} ${c.url}`).join(", ")}`).toBeDefined();
  return call!;
};

const task = (id: string): Record<string, unknown> => ({ id, title: id, status: "todo" });

describe("createTasksOneByOne (the v0 push loop, and the board's POST /api/push)", () => {
  it("stamps every create with the agent identity", async () => {
    withIdentity();
    const calls = stubFetch((url) => ({ id: `remote-${String(url).length}` }));

    await createTasksOneByOne(API, TOKEN, BOARD, [task("a"), task("b")]);

    const creates = calls.filter((c) => c.method === "POST");
    expect(creates).toHaveLength(2);
    for (const call of creates) {
      expect(agentOn(call)).toBe(ACTOR);
      expect(call.headers["X-Vibeflow-Scope"]).toBe(BOARD);
    }
  });

  it("sends NO agent header when there is no identity", async () => {
    withoutIdentity();
    const calls = stubFetch((url) => ({ id: `remote-${String(url).length}` }));

    await createTasksOneByOne(API, TOKEN, BOARD, [task("a"), task("b")]);

    const create = find(calls, "POST", "/api/v0/tasks");
    expect(create.headers).not.toHaveProperty("X-Vibeflow-Agent");
  });
});

describe("applyPushLinks (phase 2 of the push)", () => {
  it("stamps the link write with the agent identity", async () => {
    withIdentity();
    const calls = stubFetch(() => ({}));

    const result = await applyPushLinks(
      API,
      TOKEN,
      [{ id: "a", links: [{ taskId: "b", type: "parent" }] }],
      { a: "remote-a", b: "remote-b" },
      BOARD,
    );

    expect(result.applied).toBe(1);
    expect(agentOn(find(calls, "POST", "/api/v0/tasks/remote-a/links"))).toBe(ACTOR);
  });

  it("sends NO agent header when there is no identity", async () => {
    withoutIdentity();
    const calls = stubFetch(() => ({}));

    await applyPushLinks(
      API,
      TOKEN,
      [{ id: "a", links: [{ taskId: "b", type: "parent" }] }],
      { a: "remote-a", b: "remote-b" },
      BOARD,
    );

    expect(find(calls, "POST", "/api/v0/tasks/remote-a/links").headers).not.toHaveProperty(
      "X-Vibeflow-Agent",
    );
  });
});

describe("resolveRemoteTaskId (the healing GET that feeds the link/file phases)", () => {
  it("stamps the lookup with the agent identity", async () => {
    withIdentity();
    const calls = stubFetch((url) => ({ id: `remote-${String(url).split("/").pop()}` }));

    // An empty idMap forces the cliId lookup (ticket 57aff0df).
    await applyPushLinks(
      API,
      TOKEN,
      [{ id: "a", links: [{ taskId: "b", type: "parent" }] }],
      {},
      BOARD,
    );

    expect(agentOn(find(calls, "GET", "/api/v0/tasks/a"))).toBe(ACTOR);
    expect(agentOn(find(calls, "GET", "/api/v0/tasks/b"))).toBe(ACTOR);
  });

  it("sends NO agent header when there is no identity", async () => {
    withoutIdentity();
    const calls = stubFetch((url) => ({ id: `remote-${String(url).split("/").pop()}` }));

    await applyPushLinks(
      API,
      TOKEN,
      [{ id: "a", links: [{ taskId: "b", type: "parent" }] }],
      {},
      BOARD,
    );

    expect(find(calls, "GET", "/api/v0/tasks/a").headers).not.toHaveProperty(
      "X-Vibeflow-Agent",
    );
  });
});

describe("importBatchTree (multipart /api/v0/tasks/import chunks)", () => {
  const input = (id: string): ImportTaskInput => ({
    localId: id,
    record: { id, title: id, status: "todo" },
    files: [],
  });
  const importReply = {
    created: 2,
    existing: 0,
    failed: 0,
    linksApplied: 0,
    linksFailed: 0,
    filesUploaded: 0,
    filesFailed: 0,
    filesSkipped: 0,
    results: [
      { clientId: "a", id: "cloud-a" },
      { clientId: "b", id: "cloud-b" },
    ],
  };

  it("stamps every import chunk with the agent identity", async () => {
    withIdentity();
    const calls = stubFetch(() => importReply);

    await importBatchTree(API, TOKEN, BOARD, [input("a"), input("b")], {
      pacingDelayMs: 0,
    });

    expect(agentOn(find(calls, "POST", "/api/v0/tasks/import"))).toBe(ACTOR);
  });

  it("sends NO agent header when there is no identity", async () => {
    withoutIdentity();
    const calls = stubFetch(() => importReply);

    await importBatchTree(API, TOKEN, BOARD, [input("a"), input("b")], {
      pacingDelayMs: 0,
    });

    expect(find(calls, "POST", "/api/v0/tasks/import").headers).not.toHaveProperty(
      "X-Vibeflow-Agent",
    );
  });
});

describe("sendDeltaArchive (gzipped tar chunks)", () => {
  const chunk = {
    tasks: [{ id: "t1", raw: { id: "t1", title: "a" }, files: [] }],
    unchangedTaskIds: [],
    droppedFileCount: 0,
  };
  function archiveFetch(): { calls: Recorded[]; impl: typeof fetch } {
    const calls: Recorded[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body,
      });
      return { ok: true, status: 200, text: async () => "" };
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it("stamps the archive POST with the agent identity", async () => {
    withIdentity();
    const { calls, impl } = archiveFetch();

    const result = await sendDeltaArchive({
      apiUrl: API,
      token: TOKEN,
      headers: { "X-Vibeflow-Scope": BOARD },
      boardId: BOARD,
      chunks: [chunk],
      fetchImpl: impl,
    });

    expect(result.ok).toBe(true);
    expect(agentOn(find(calls, "POST", `/api/v0/tasks/import/archive?boardId=${BOARD}`))).toBe(
      ACTOR,
    );
  });

  it("sends NO agent header when there is no identity", async () => {
    withoutIdentity();
    const { calls, impl } = archiveFetch();

    await sendDeltaArchive({
      apiUrl: API,
      token: TOKEN,
      headers: { "X-Vibeflow-Scope": BOARD },
      boardId: BOARD,
      chunks: [chunk],
      fetchImpl: impl,
    });

    expect(
      find(calls, "POST", `/api/v0/tasks/import/archive?boardId=${BOARD}`).headers,
    ).not.toHaveProperty("X-Vibeflow-Agent");
  });
});

describe("uploadTaskFiles (the legacy push file phase)", () => {
  function projectWithFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "vf-agent-header-"));
    tempDirs.push(dir);
    const filesDir = join(dir, ".vibeflow", "tasks", "files", "t1");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "shot.png"), "PNGDATA");
    vi.mocked(filesModule.listFiles).mockReturnValue([
      { name: "shot.png", size: 7, url: "" },
    ]);
    return dir;
  }

  it("stamps every file POST with the agent identity", async () => {
    withIdentity();
    const calls = stubFetch(() => ({}));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await uploadTaskFiles(
      API,
      TOKEN,
      projectWithFile(),
      [{ localId: "t1", remoteId: "remote-1" }],
      BOARD,
    );

    expect(result.uploaded).toBe(1);
    expect(agentOn(find(calls, "POST", "/api/v0/tasks/remote-1/files"))).toBe(ACTOR);
  });

  it("sends NO agent header when there is no identity", async () => {
    withoutIdentity();
    const calls = stubFetch(() => ({}));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await uploadTaskFiles(
      API,
      TOKEN,
      projectWithFile(),
      [{ localId: "t1", remoteId: "remote-1" }],
      BOARD,
    );

    expect(
      find(calls, "POST", "/api/v0/tasks/remote-1/files").headers,
    ).not.toHaveProperty("X-Vibeflow-Agent");
  });
});

/**
 * End-to-end on ONE bulk path: the header the push writes becomes the event
 * field the follow loop filters on. The double stands in for the hosted route
 * (which stores `X-Vibeflow-Agent` as the event `agent`, ADR-0003) and derives
 * the feed from what the request actually carried — so if a surface stops
 * sending the header, the follower starts receiving its own push.
 */
describe("echo filter on a bulk push (header → event → delivery decision)", () => {
  it("suppresses the pusher's own events and delivers a peer's", async () => {
    withIdentity();
    const calls = stubFetch(() => ({}));

    await createTasksOneByOne(API, TOKEN, BOARD, [task("a"), task("b")]);

    // The hosted boundary (ADR-0003) stores the header it received as the
    // event's `agent` — derived here from the request, never assumed.
    const feed = calls
      .filter((call) => call.method === "POST")
      .map((call, i) => ({
        type: "task.create",
        taskId: `t${i}`,
        actor: "user-1",
        ...(agentOn(call) !== undefined ? { agent: agentOn(call) } : {}),
      }));

    expect(feed).toHaveLength(2);
    for (const event of feed) {
      expect(isOwnNotification(event, ACTOR)).toBe(true);
      expect(isOwnNotification(event, "pi-someone-else")).toBe(false);
    }
    // A user's write is always delivered.
    expect(isOwnNotification({ type: "task.update", taskId: "t1", actor: "user-1" }, ACTOR)).toBe(
      false,
    );
  });

  it("delivers an unidentified push (silence must never come from an unknown identity)", async () => {
    withoutIdentity();
    const calls = stubFetch(() => ({}));

    await createTasksOneByOne(API, TOKEN, BOARD, [task("a")]);

    const feed = calls
      .filter((call) => call.method === "POST")
      .map((call) => ({
        type: "task.create",
        taskId: "t0",
        actor: "agent",
        ...(agentOn(call) !== undefined ? { agent: agentOn(call) } : {}),
      }));
    expect(feed).toHaveLength(1);
    expect(feed[0]).not.toHaveProperty("agent");
    expect(isOwnNotification(feed[0], ACTOR)).toBe(false);
  });
});
