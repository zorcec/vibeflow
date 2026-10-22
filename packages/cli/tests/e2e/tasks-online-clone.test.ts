/**
 * CLI e2e — clone mode (ticket 4efaa878): a task created while logged in
 * (online mode) is ALSO persisted in the local `.vibeflow` store as its
 * normal `.json` record, so the local copy exists for grep/diff/inspection
 * offline and the two stay identical.
 *
 * The fake backend below mirrors the REAL v0 contract: the stored `raw` is
 * the VERBATIM client body (plus backfilled id/links — no merged column
 * defaults, no author/timestamps/comments/files arrays, exactly like
 * `buildV0CreateRaw`), the row columns (`createdAt`, `updatedAt`, author)
 * live BESIDE it, the create view echoes the columns, and the create
 * response carries the accepted raw on the explicit `record` member. The
 * export archive serves the stored raws verbatim. That shape is the honest
 * one to fake: test 1 proves the clone deep-equals the response's own
 * `record` member (not the fake's internals — a test that reuses the
 * mapper's invention as the fake proves nothing), and test 3 proves the
 * export of that same stored state merges to zero writes.
 *
 * The first four tests are ONE ordered chain sharing a fake and a store —
 * deliberately, not incidentally: the requirement is a sequence (create,
 * then push sees it as existing, then pull is a no-op, then delete drops
 * the clone), and each step needs the previous step's state. The patch
 * test and the failed-create test use fresh fixtures (a patch mutates
 * server state, which would turn the shared pull into a merge).
 *
 * Non-vacuity proof: with the `writeOnlineClone` call removed from the
 * online `--add` path, test 1 fails (no local file); with the clone built
 * from the request instead of the response (e.g. the locally-minted id),
 * test 1 fails on the id deep-equal; with the `record` member dropped from
 * the fake response, test 1 fails (the CLI warns and reconstructs); with
 * the local delete dropped from the online delete path, test 4 fails
 * (stale clone on disk).
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
/** Row columns that live BESIDE the raw (never inside it) — the real server
 * keeps minted sortKey, stamped author and timestamps in the row while the
 * raw stays the verbatim client body. */
type StoredColumns = { createdAt: string; updatedAt: string; author: string };

/**
 * v0 view of one stored task (what the wire carries): the COLUMN echo plus
 * the accepted `record` member — exactly the shape the real create route
 * answers (`serializeV0Task(row)` spread with `record`). Columns echo the
 * stored row (null when the client sent nothing, like the real nullable
 * columns); the raw travels untouched on `record`.
 */
function v0View(
  record: StoredRecord,
  columns: StoredColumns,
): Record<string, unknown> {
  return {
    id: record.id,
    externalId: record.id,
    title: record.title,
    description:
      typeof record.description === "string" ? record.description : null,
    status:
      typeof record.status === "string" ? record.status : "todo",
    priority: typeof record.priority === "string" ? record.priority : null,
    type: typeof record.type === "string" ? record.type : null,
    boardId: "board-1",
    createdAt: columns.createdAt,
    selector: typeof record.selector === "string" ? record.selector : null,
    author: columns.author,
    updatedAt: columns.updatedAt,
    links: Array.isArray(record.links) ? record.links : [],
    comments: [],
    commentCount: 0,
    fileCount: 0,
    files: [],
    // The ACCEPTED raw, verbatim — this member is the whole clone contract.
    record,
  };
}

async function startFakeBackend(): Promise<{
  url: string;
  requests: RecordedRequest[];
  records: Map<string, StoredRecord>;
  columns: Map<string, StoredColumns>;
  failCreates: { value: boolean };
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const records = new Map<string, StoredRecord>();
  const columns = new Map<string, StoredColumns>();
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
        const id = decodeURIComponent(detailMatch[1]);
        const record = records.get(id);
        const cols = columns.get(id);
        if (!record || !cols) {
          finish(404, { error: "Task not found", code: "NOT_FOUND" });
          return;
        }
        finish(200, v0View(record, cols));
        return;
      }
      finish(200, {
        items: [...records.entries()].map(([id, record]) =>
          v0View(record, columns.get(id)!),
        ),
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
        // Verbatim-raw cut, exactly like the real `buildV0CreateRaw`: the
        // stored raw is the SENT body (transport routing stripped) plus the
        // backfilled id and validated links — no merged column defaults, no
        // author/timestamps/comments/files (those live in the row, never in
        // the record). The export serves these bytes verbatim (manifest
        // hash == inventory hash over the same bytes).
        const record: StoredRecord = { ...(parsed as StoredRecord) };
        delete record.boardId;
        record.id = id;
        if (!Array.isArray(record.links)) delete record.links;
        if (typeof record.title !== "string") record.title = "Untitled";
        records.set(id, record);
        // Row columns: minted server-side, echoed by the view, never stored
        // in the raw.
        const cols: StoredColumns = {
          createdAt: now,
          updatedAt: now,
          author: "Test User",
        };
        columns.set(id, cols);
        finish(201, v0View(record, cols));
        return;
      }
      const patchMatch = url.match(/^\/api\/v0\/tasks\/([^/]+)$/);
      if (req.method === "PATCH" && patchMatch) {
        const id = decodeURIComponent(patchMatch[1]);
        const record = records.get(id);
        const cols = columns.get(id);
        if (!record || !cols) {
          finish(404, { error: "Task not found", code: "NOT_FOUND" });
          return;
        }
        // Real PATCH semantics, minimally: scalar fields land in BOTH the
        // row and the raw (the raw is the record of truth), `updatedAt`
        // advances. Unknown keys are ignored, like the validated real route.
        const patch = (body ? JSON.parse(body) : {}) as Record<
          string,
          unknown
        >;
        for (const key of ["title", "status", "priority", "type"]) {
          if (typeof patch[key] === "string") record[key] = patch[key];
        }
        if (typeof patch.description === "string" || patch.description === null)
          record.description = patch.description as string | null;
        cols.updatedAt = new Date().toISOString();
        finish(200, v0View(record, cols));
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
    columns,
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

  it("1. create online writes the local .json byte-equal to the `record` member", async () => {
    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Clone me", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: backend.url } },
    );
    expect(r.code).toBe(0);
    // Success envelopes go to stdout (refusals go to stderr). The task
    // payload is the FULL create response, including the accepted `record`.
    const envelope = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { id: string; record: Record<string, unknown> };
    };
    expect(envelope.ok).toBe(true);
    createdId = envelope.task.id;

    // Identity: the clone reuses the ACCEPTED id (the fake honours the
    // client-sent id, like the real server's (boardId, localTaskId) rule).
    expect(backend.records.get(createdId)).toBeDefined();
    // The response carries the accepted raw — the test reads it from the
    // RESPONSE (what the CLI saw), never from the fake's internals, so a
    // fake that shares the mapper's invention cannot pass.
    const accepted = envelope.task.record;
    expect(accepted).toBeDefined();
    expect(accepted.id).toBe(createdId);

    const files = taskFiles(store);
    expect(files).toHaveLength(1);
    const clone = JSON.parse(readFileSync(files[0]!, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(clone.id).toBe(createdId);
    // The clone deep-equals the ACCEPTED record — same bytes the next pull
    // exports and the next push hashes — plus only the two load-bearing
    // local keys the raw carries neither of (`sortKey` for board order,
    // `created` for the date-subdir path; see saas/clone.ts).
    const { sortKey: _cloneSortKey, created: _cloneCreated, ...cloneRest } =
      clone;
    expect(cloneRest).toEqual(accepted);
    expect(typeof _cloneSortKey).toBe("string");
    expect(typeof _cloneCreated).toBe("string");
    // No invented defaults on the exact path: a bare create sends no
    // description/selector, so the accepted raw carries neither.
    expect(clone).not.toHaveProperty("selector");
    expect(clone).not.toHaveProperty("comments");
    expect(clone).not.toHaveProperty("files");
    expect(r.stderr).not.toMatch(/RECONSTRUCTED/);
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

describe("clone mode: online patch never rewrites the clone", () => {
  it("create -> patch leaves the clone's author/sortKey untouched", async () => {
    const backend = await startFakeBackend();
    try {
      const store = freshDir("clone-patch-store-");
      const home = saasHome();
      const created = await spawnCli(
        ["tasks", store, "--add", "--title", "Patch me", "--json"],
        { cwd: store, home, env: { VIBEFLOW_API_URL: backend.url } },
      );
      expect(created.code).toBe(0);
      const envelope = JSON.parse(created.stdout) as {
        ok: boolean;
        task: { id: string };
      };
      const id = envelope.task.id;
      const files = taskFiles(store);
      expect(files).toHaveLength(1);
      const before = readFileSync(files[0]!, "utf-8");
      const beforeJson = JSON.parse(before) as Record<string, unknown>;

      // Online update: moves the task server-side (status + updatedAt).
      const patched = await spawnCli(
        ["tasks", store, "--edit", id, "--set-status", "in-progress", "--json"],
        { cwd: store, home, env: { VIBEFLOW_API_URL: backend.url } },
      );
      expect(patched.code).toBe(0);
      // The raw is the record of truth: it keeps the wire spelling the CLI
      // sent (`in_progress`), exactly like the real verbatim raw.
      expect(backend.records.get(id)?.status).toBe("in_progress");

      // ...but the clone is byte-identical: update does not clone (out of
      // scope by design), so neither the minted sortKey nor the author the
      // server stamped at create can drift.
      const after = readFileSync(files[0]!, "utf-8");
      expect(after).toBe(before);
      const afterJson = JSON.parse(after) as Record<string, unknown>;
      expect(afterJson.sortKey).toBe(beforeJson.sortKey);
    } finally {
      await backend.close();
    }
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
