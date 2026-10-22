/**
 * CLI e2e — clone mode (ticket 4efaa878): a task created while logged in
 * (online mode) is ALSO persisted in the local `.vibeflow` store as its
 * normal `.json` record, so the local copy exists for grep/diff/inspection
 * offline and the two stay identical.
 *
 * The fake backend below emulates a server whose stored `raw` IS the
 * local-style record: POST builds the accepted record (honouring the
 * client-sent id — the `(boardId, localTaskId)` identity rule), stores it,
 * and answers the v0 view of it; the export archive serves the stored
 * records verbatim. That shape is the honest one to fake: test 1 proves the
 * clone deep-equals the server's stored bytes even though the CLI only ever
 * saw the v0 response (so the mapping round-trips), and test 3 proves the
 * export of that same stored state merges to zero writes. What the fake
 * CANNOT prove is the real server's synthesis (its defaults for priority /
 * type / selector on a bare single-create) — the real smoke in the ticket
 * gates covers that, and the unit suite pins whatever mapping ships.
 *
 * The first four tests are ONE ordered chain sharing a fake and a store —
 * deliberately, not incidentally: the requirement is a sequence (create,
 * then push sees it as existing, then pull is a no-op, then delete drops
 * the clone), and each step needs the previous step's state. The fifth
 * (failed create leaves nothing) uses fresh fixtures.
 *
 * Non-vacuity proof: with the `writeOnlineClone` call removed from the
 * online `--add` path, test 1 fails (no local file); with the clone built
 * from the request instead of the response (e.g. the locally-minted id),
 * test 1 fails on the id/created deep-equal; with the local delete dropped
 * from the online delete path, test 4 fails (stale clone on disk).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { writeTar } from "@vibeflow-tools/shared/tar";
import { hashTaskRecord } from "@vibeflow-tools/shared/delta-hash";
import { spawnCli } from "./mcp-helpers.js";

const cleanups: Array<() => void> = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A home directory that makes the CLI take the online (SaaS) branch. */
function saasHome(): string {
  const home = freshDir("clone-home-");
  mkdirSync(join(home, ".vibeflow"), { recursive: true });
  writeFileSync(join(home, ".vibeflow", "token"), "test-token", "utf-8");
  return home;
}

type RecordedRequest = { method: string; url: string; body: string };
type StoredRecord = Record<string, unknown>;

/** v0 view of a stored local-style record (what the wire carries). */
function v0View(record: StoredRecord): Record<string, unknown> {
  const comments = (
    Array.isArray(record.comments) ? record.comments : []
  ) as Array<Record<string, unknown>>;
  return {
    id: record.id,
    externalId: record.id,
    title: record.title,
    description: record.description ?? null,
    status: record.status,
    priority: record.priority ?? null,
    type: record.type ?? null,
    boardId: "board-1",
    createdAt: record.created,
    // A LOSSY view, exactly like the real one (proven by smoke):
    // description and selector are answered as null even though the stored
    // raw carries the server defaults ("" / "/") — the clone must
    // reconstruct them (see saas/clone.ts). Every other stored field is
    // echoed, including the updatedAt column echo the real view always
    // carries (SaasTask.updatedAt is required).
    description: null,
    selector: null,
    author: record.author ?? null,
    updatedAt: record.updated ?? record.created,
    links: record.links ?? [],
    comments: comments.map((c) => ({
      id: c.id,
      author: c.author,
      text: c.text,
      createdAt: c.createdAt,
    })),
    commentCount: comments.length,
    fileCount: 0,
    files: [],
  };
}

async function startFakeBackend(): Promise<{
  url: string;
  requests: RecordedRequest[];
  records: Map<string, StoredRecord>;
  failCreates: { value: boolean };
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const records = new Map<string, StoredRecord>();
  const failCreates = { value: false };
  const server: Server = createServer((req, res) => {
    const finish = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = req.url ?? "";

    // Pull transport: the export archive serves the STORED records
    // verbatim (manifest hashes over the same bytes), exactly as the real
    // export serves the stored raws.
    if (req.method === "POST" && url.startsWith("/api/v0/tasks/export/archive")) {
      const items = [...records.values()];
      const manifest = {
        version: 1,
        kind: "vibeflow-board-export",
        boardId: "board-1",
        taskCount: items.length,
        fileCount: 0,
        totalFileBytes: 0,
        tasks: items.map((record) => ({
          cliId: record.id,
          hash: hashTaskRecord(record),
          fileCount: 0,
        })),
        files: [],
      };
      const bytes = gzipSync(
        writeTar([
          { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
          ...items.map((record) => ({
            path: `tasks/${String(record.id)}.json`,
            data: Buffer.from(
              JSON.stringify({ clientId: record.id, record }),
            ),
          })),
        ]),
      );
      res.writeHead(200, { "Content-Type": "application/gzip" });
      res.end(bytes);
      return;
    }

    if (req.method === "GET" && url.startsWith("/api/v0/tasks")) {
      if (/\/api\/v0\/tasks\/[^/?]+\/comments/.test(url)) {
        finish(200, { comments: [] });
        return;
      }
      if (/\/api\/v0\/tasks\/[^/?]+\/files/.test(url)) {
        finish(200, { files: [] });
        return;
      }
      // A path segment means the detail route (the list carries its paging
      // as a query string, never as a segment); unknown ids 404.
      // `/api/v0/tasks/import` lands here too and 404s — the import probe
      // reads that as "old server", so push takes the id-diff path.
      const detailMatch = url.match(/^\/api\/v0\/tasks\/([^/?]+)/);
      if (detailMatch) {
        const record = records.get(decodeURIComponent(detailMatch[1]));
        if (!record) {
          finish(404, { error: "Task not found", code: "NOT_FOUND" });
          return;
        }
        finish(200, v0View(record));
        return;
      }
      finish(200, {
        items: [...records.values()].map(v0View),
        nextCursor: null,
      });
      return;
    }

    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url, body });
      if (req.method === "POST" && url === "/api/v0/tasks") {
        if (failCreates.value) {
          finish(500, { error: "boom" });
          return;
        }
        const parsed = (body ? JSON.parse(body) : {}) as {
          id?: unknown;
          title?: unknown;
          description?: unknown;
          status?: unknown;
          links?: unknown;
        };
        // Identity rule: the server stores the task under the client-sent
        // id (boardId, localTaskId) — the clone must reuse the ACCEPTED id,
        // never assume the locally-minted one survived.
        const id =
          typeof parsed.id === "string" && parsed.id.length > 0
            ? parsed.id
            : `server-minted-${records.size + 1}`;
        const now = new Date().toISOString();
        // Server synthesis, exactly as the real smoke proved it: a
        // single-create stores description "" / selector "/" / both
        // timestamps / the row author, but NO priority / type (the view
        // answers null for those and the export record lacks them) — and
        // the export serves the stored record verbatim (manifest hash ==
        // inventory hash over the same bytes).
        const record: StoredRecord = {
          id,
          title: typeof parsed.title === "string" ? parsed.title : "Untitled",
          description:
            typeof parsed.description === "string" ? parsed.description : "",
          status: typeof parsed.status === "string" ? parsed.status : "todo",
          selector: "/",
          author: "Test User",
          created: now,
          updated: now,
          comments: [],
          files: [],
          ...(Array.isArray(parsed.links) && parsed.links.length > 0
            ? { links: parsed.links }
            : {}),
        };
        records.set(id, record);
        finish(201, v0View(record));
        return;
      }
      const deleteMatch = url.match(/^\/api\/v0\/tasks\/([^/]+)$/);
      if (req.method === "DELETE" && deleteMatch) {
        const id = decodeURIComponent(deleteMatch[1]);
        if (!records.has(id)) {
          finish(404, { error: "Task not found", code: "NOT_FOUND" });
          return;
        }
        records.delete(id);
        // The v0 DELETE answers the deleted cone (here: the task alone).
        finish(200, { success: true, deletedIds: [id] });
        return;
      }
      finish(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    records,
    failCreates,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Every task .json under the store, recursively. */
function taskFiles(store: string): string[] {
  const root = join(store, ".vibeflow", "tasks");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".json")) out.push(abs);
    }
  };
  walk(root);
  return out.sort();
}

afterAll(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("clone mode: online create also persists the local record", () => {
  let backend: Awaited<ReturnType<typeof startFakeBackend>>;
  let store: string;
  let home: string;
  let createdId: string;

  beforeAll(async () => {
    backend = await startFakeBackend();
    store = freshDir("clone-store-");
    home = saasHome();
  });

  afterAll(async () => {
    await backend.close();
  });

  it("1. create online writes the local .json byte-equal to the server-accepted record", async () => {
    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Clone me", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: backend.url } },
    );
    expect(r.code).toBe(0);
    // Success envelopes go to stdout (refusals go to stderr).
    const envelope = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { id: string };
    };
    expect(envelope.ok).toBe(true);
    createdId = envelope.task.id;

    // Identity: the clone reuses the ACCEPTED id (the fake honours the
    // client-sent id, like the real server's (boardId, localTaskId) rule).
    const stored = backend.records.get(createdId);
    expect(stored).toBeDefined();

    const files = taskFiles(store);
    expect(files).toHaveLength(1);
    const clone = JSON.parse(readFileSync(files[0]!, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(clone.id).toBe(createdId);
    // The clone deep-equals the record the server stored — same bytes the
    // next pull exports and the next push hashes — except sortKey, the one
    // locally-minted field (the response carries none; see saas/clone.ts).
    const { sortKey: _cloneSortKey, ...cloneRest } = clone;
    const { sortKey: _storedSortKey, ...storedRest } = stored!;
    expect(cloneRest).toEqual(storedRest);
    expect(typeof _cloneSortKey).toBe("string");
  });

  it("2. push immediately after reports nothing to push and sends no POST", async () => {
    const postsBefore = backend.requests.filter(
      (q) => q.method === "POST" && q.url === "/api/v0/tasks",
    ).length;
    const r = await spawnCli(["push", store, "--board", "board-1"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: backend.url },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Nothing to push");
    const postsAfter = backend.requests.filter(
      (q) => q.method === "POST" && q.url === "/api/v0/tasks",
    ).length;
    expect(postsAfter).toBe(postsBefore);
  });

  it("3. pull writes zero files — the clone already matches", async () => {
    const r = await spawnCli(["pull", store, "--board", "board-1", "--json"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: backend.url },
    });
    expect(r.code).toBe(0);
    // --json shares stdout with the human banner line; the payload is the
    // JSON object at the end.
    const summary = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as {
      added: number;
      merged: number;
      unchanged: number;
      filesWritten: number;
    };
    expect(summary.added).toBe(0);
    expect(summary.merged).toBe(0);
    expect(summary.unchanged).toBe(1);
    expect(summary.filesWritten).toBe(0);
  });

  it("4. delete online drops the local clone", async () => {
    const r = await spawnCli(["tasks", store, "--delete", createdId, "--yes"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: backend.url },
    });
    expect(r.code).toBe(0);
    expect(backend.records.has(createdId)).toBe(false);
    expect(taskFiles(store)).toHaveLength(0);
  });
});

describe("clone mode: a failed online write leaves nothing behind", () => {
  it("5. failed create (500) writes no local file", async () => {
    const backend = await startFakeBackend();
    try {
      backend.failCreates.value = true;
      const store = freshDir("clone-fail-store-");
      const home = saasHome();
      const r = await spawnCli(
        ["tasks", store, "--add", "--title", "Never lands", "--json"],
        { cwd: store, home, env: { VIBEFLOW_API_URL: backend.url } },
      );
      expect(r.code).not.toBe(0);
      expect(backend.records.size).toBe(0);
      expect(taskFiles(store)).toHaveLength(0);
    } finally {
      await backend.close();
    }
  });
});
