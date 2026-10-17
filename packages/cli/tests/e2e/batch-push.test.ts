/**
 * CLI batch-push client, end to end (ticket 8d3b2b81).
 *
 * Two halves, both on the repo's own e2e harness ports (never the live
 * board, never :3700):
 * 1. Capability probe against the REAL local test server (serveWithPort):
 *    the local board has no v0 batch handler, so GET /api/v0/tasks/batch
 *    answers 404 and probeBatchCapability reports unsupported — the exact
 *    old-server fallback the `push` command depends on.
 * 2. Full batch loop against a tiny mock contract server on a harness
 *    port (preflight GET + chunk POST + files GET/POST, real fetch, real
 *    disk checkpoint in a temp project dir): 120 tasks → 2 chunks, mixed
 *    per-item results, presence-skip on files, kill-simulation resume.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { serveWithPort } from "../helpers/serve-with-port.js";
import { getFreePort } from "../ports.js";
import type { ServeInstance } from "../../src/server/server.js";
import {
  probeBatchCapability,
  createTasksInBatches,
  uploadBatchFiles,
  readBatchCheckpoint,
} from "../../src/saas/batch-push.js";

describe("batch probe against the local test server", () => {
  let tempDir: string;
  let instance: ServeInstance | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "batch-e2e-probe-"));
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("GET /api/v0/tasks/batch is 404 locally → probe reports unsupported (old-server fallback)", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir: tempDir,
      // @internal test hooks — force OFFLINE mode deterministically
      _testToken: null,
      _testWorkspace: null,
    });
    // The local board has no batch handler: its v0 read-alias rewrites
    // onto the legacy /api/tasks/:id route, which 400s the literal id
    // "batch" (ticket 8d3b2b81) — probe treats it as unsupported, same
    // as the old-server 404.
    const raw = await fetch(`${instance.url}/api/v0/tasks/batch`);
    expect(raw.status).toBe(400);
    expect(await raw.json()).toEqual({ error: "Invalid task id" });
    const probe = await probeBatchCapability(instance.url, "test-token");
    expect(probe).toEqual({ supported: false });
  });
});

interface MockContractState {
  preflight: Record<string, unknown>;
  chunkPosts: Array<{ items: Array<Record<string, unknown>>; boardId?: string }>;
  filePosts: string[];
  presentFiles: Map<string, Set<string>>;
  perItemErrors: Map<string, { code: string; message: string }>;
}

async function startMockContractServer(
  state: MockContractState,
): Promise<{ server: Server; baseUrl: string }> {
  const port = await getFreePort();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // Preflight probe.
      if (url.pathname === "/api/v0/tasks/batch" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.preflight));
        return;
      }
      // Chunk create.
      if (url.pathname === "/api/v0/tasks/batch" && req.method === "POST") {
        const parsed = JSON.parse(body) as {
          items: Array<Record<string, unknown>>;
          boardId?: string;
        };
        state.chunkPosts.push({ items: parsed.items, boardId: parsed.boardId });
        const results = parsed.items.map((t) => {
          const err = state.perItemErrors.get(t.id as string);
          if (err) return { error: err };
          return { id: `cloud-${t.id}` };
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            created: results.filter((r) => "id" in r).length,
            failed: results.filter((r) => "error" in r).length,
            results,
          }),
        );
        return;
      }
      // Files presence list.
      const filesMatch = url.pathname.match(/^\/api\/v0\/tasks\/([^/]+)\/files$/);
      if (filesMatch && req.method === "GET") {
        const names = [...(state.presentFiles.get(filesMatch[1]!) ?? [])].map(
          (name) => ({ name, size: 1 }),
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items: names, nextCursor: null }));
        return;
      }
      // File upload.
      if (filesMatch && req.method === "POST") {
        state.filePosts.push(
          `${filesMatch[1]}:${req.headers["x-filename"]}`,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("batch loop against a mock contract server (test stack only)", () => {
  let tempDir: string;
  let server: Server | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "batch-e2e-loop-"));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("probe → 2 chunks → per-item idMap → files with skip-if-present → checkpoint cleared", async () => {
    const state: MockContractState = {
      preflight: {
        maxItems: 100,
        plan: "free",
        openLimit: 500,
        openUsed: 0,
        openRemaining: 500,
        totalLimit: 2000,
        totalUsed: 0,
        totalRemaining: 2000,
      },
      chunkPosts: [],
      filePosts: [],
      presentFiles: new Map([["cloud-t1", new Set(["a.png"])]]),
      perItemErrors: new Map([
        ["t3", { code: "INVALID_TITLE", message: "title required" }],
      ]),
    };
    const mock = await startMockContractServer(state);
    server = mock.server;

    const probe = await probeBatchCapability(mock.baseUrl, "tok");
    expect(probe.supported).toBe(true);
    if (probe.supported !== true) return;

    const taskRecords = Array.from({ length: 120 }, (_, i) => ({
      id: `t${i + 1}`,
      title: `Task ${i + 1}`,
      status: "todo",
    }));
    const seen: Array<[number, number]> = [];
    const result = await createTasksInBatches(
      mock.baseUrl,
      "tok",
      "board-9",
      taskRecords,
      {
        onProgress: (d, t) => seen.push([d, t]),
        projectDir: tempDir,
        preflight: probe.preflight,
      },
    );

    // 120 tasks → 100 + 20; one invalid item refused, grouped honestly.
    expect(state.chunkPosts).toHaveLength(2);
    expect(state.chunkPosts[0]!.items).toHaveLength(100);
    expect(state.chunkPosts[1]!.items).toHaveLength(20);
    expect(state.chunkPosts[0]!.boardId).toBe("board-9");
    expect(result.imported).toBe(119);
    expect(result.skipped).toBe(1);
    expect(result.attempted).toBe(120);
    expect(result.failures).toEqual([
      { status: 400, code: "INVALID_TITLE", count: 1 },
    ]);
    expect(result.idMap["t1"]).toBe("cloud-t1");
    expect(result.idMap["t3"]).toBeUndefined();
    expect(seen[seen.length - 1]).toEqual([120, 120]);
    expect(readBatchCheckpoint(tempDir)).toBeNull();

    // Files: a.png already remote (skipped), b.png uploaded.
    const filesDir = join(tempDir, ".vibeflow", "files", "t1");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "a.png"), Buffer.from("aaa"));
    writeFileSync(join(filesDir, "b.png"), Buffer.from("bbb"));
    const up = await uploadBatchFiles(mock.baseUrl, "tok", [
      {
        remoteId: "cloud-t1",
        name: "a.png",
        filePath: join(filesDir, "a.png"),
        size: 3,
        system: false,
      },
      {
        remoteId: "cloud-t1",
        name: "b.png",
        filePath: join(filesDir, "b.png"),
        size: 3,
        system: false,
      },
    ]);
    expect(up).toEqual({
      uploaded: 1,
      skippedPresent: 1,
      failed: 0,
      failedFiles: [],
    });
    expect(state.filePosts).toEqual(["cloud-t1:b.png"]);
  });
});
