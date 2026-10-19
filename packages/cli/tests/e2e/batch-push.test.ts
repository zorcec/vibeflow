/**
 * CLI tree-import client, end to end (ticket bulk-429).
 *
 * Two halves, both on the repo's own e2e harness ports (never the live
 * board, never :3700):
 * 1. Capability probe against the REAL local test server (serveWithPort):
 *    the local board has no v0 import handler, so GET /api/v0/tasks/import
 *    answers 400 and probeImportCapability reports unsupported — the exact
 *    old-server fallback the `push` command depends on.
 * 2. Full import loop against a tiny mock contract server on a harness
 *    port (preflight GET + multipart chunk POST, real fetch, real disk
 *    checkpoint in a temp project dir): 120 tasks → 2 chunks, mixed
 *    per-item results, in-manifest parent links, server-side file skip,
 *    checkpoint cleared.
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
  probeImportCapability,
  importBatchTree,
  readBatchCheckpoint,
} from "../../src/saas/batch-push.js";

describe("import probe against the local test server", () => {
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

  it("GET /api/v0/tasks/import is 400 locally → probe reports unsupported (old-server fallback)", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir: tempDir,
      // @internal test hooks — force OFFLINE mode deterministically
      _testToken: null,
      _testWorkspace: null,
    });
    // The local board has no import handler: its v0 read-alias rewrites
    // onto the legacy /api/tasks/:id route, which 400s the literal id
    // "import" — probe treats it as unsupported, same as the old-server
    // 404.
    const raw = await fetch(`${instance.url}/api/v0/tasks/import`);
    expect(raw.status).toBe(400);
    expect(await raw.json()).toEqual({ error: "Invalid task id" });
    const probe = await probeImportCapability(instance.url, "test-token");
    expect(probe).toEqual({ supported: false });
  });
});

interface MockContractState {
  preflight: Record<string, unknown>;
  chunkPosts: Array<{ tasks: Array<Record<string, unknown>>; boardId?: string }>;
  filePosts: string[];
  presentFiles: Map<string, Set<string>>;
  perItemErrors: Map<string, { code: string; message: string }>;
}

async function startMockContractServer(
  state: MockContractState,
): Promise<{ server: Server; baseUrl: string }> {
  const port = await getFreePort();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // Preflight probe.
      if (url.pathname === "/api/v0/tasks/import" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.preflight));
        return;
      }
      // Tree import: multipart with a `manifest` JSON part + ref-keyed
      // file parts. The mock extracts the manifest with a naive scan
      // (test files are tiny text) and answers the import envelope:
      // per-item `{ id } | { error }` in manifest order, parent links
      // resolved to cloud ids, present names skipped.
      if (url.pathname === "/api/v0/tasks/import" && req.method === "POST") {
        const body = Buffer.concat(chunks).toString("utf8");
        const manifestMatch = body.match(/name="manifest"\r\n\r\n([\s\S]*?)\r\n--/);
        const manifest = JSON.parse(manifestMatch?.[1] ?? '{"tasks":[]}') as {
          boardId?: string;
          tasks: Array<{
            clientId: string;
            fields: Record<string, unknown>;
            parentClientIds?: string[];
            files?: Array<{ ref: string; name: string }>;
          }>;
        };
        state.chunkPosts.push({ tasks: manifest.tasks, boardId: manifest.boardId });
        let created = 0;
        let failed = 0;
        let linksApplied = 0;
        let filesUploaded = 0;
        let filesSkipped = 0;
        const results = manifest.tasks.map((t) => {
          const err = state.perItemErrors.get(t.clientId as string);
          if (err) {
            failed++;
            return { clientId: t.clientId, error: err };
          }
          created++;
          const id = `cloud-${t.clientId}`;
          const links = (t.parentClientIds ?? []).map((p) => {
            linksApplied++;
            return { type: "parent", taskId: `cloud-${p}` };
          });
          const present = state.presentFiles.get(id) ?? new Set<string>();
          const files = (t.files ?? []).map((f) => {
            if (present.has(f.name)) {
              filesSkipped++;
              return { ref: f.ref, name: f.name, skipped: true, file: { name: f.name } };
            }
            filesUploaded++;
            state.filePosts.push(`${id}:${f.name}`);
            present.add(f.name);
            return { ref: f.ref, name: f.name, file: { name: f.name } };
          });
          state.presentFiles.set(id, present);
          return { clientId: t.clientId, id, links, files };
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            created,
            existing: 0,
            failed,
            linksApplied,
            linksFailed: 0,
            filesUploaded,
            filesFailed: 0,
            filesSkipped,
            results,
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("import loop against a mock contract server (test stack only)", () => {
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

  it("probe → 2 chunks → per-item idMap → links + files in one call → checkpoint cleared", async () => {
    const state: MockContractState = {
      preflight: {
        maxTasks: 100,
        maxFiles: 50,
        maxBytes: 25 * 1024 * 1024,
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

    const probe = await probeImportCapability(mock.baseUrl, "tok");
    expect(probe.supported).toBe(true);
    if (probe.supported !== true) return;

    const inputs = Array.from({ length: 120 }, (_, i) => ({
      localId: `t${i + 1}`,
      record: {
        id: `t${i + 1}`,
        title: `Task ${i + 1}`,
        status: "todo",
        ...(i === 1 ? { links: [{ taskId: "t1", type: "parent" }] } : {}),
      },
      files: [],
    }));
    // t1 carries two files: a.png already remote (skipped), b.png uploaded.
    const filesDir = join(tempDir, ".vibeflow", "files", "t1");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "a.png"), Buffer.from("aaa"));
    writeFileSync(join(filesDir, "b.png"), Buffer.from("bbb"));
    inputs[0]!.files = [
      { name: "a.png", filePath: join(filesDir, "a.png"), size: 3, system: false },
      { name: "b.png", filePath: join(filesDir, "b.png"), size: 3, system: false },
    ];
    const seen: Array<[number, number]> = [];
    const result = await importBatchTree(
      mock.baseUrl,
      "tok",
      "board-9",
      inputs,
      {
        onProgress: (d, t) => seen.push([d, t]),
        projectDir: tempDir,
        preflight: probe.preflight,
        pacingDelayMs: 0,
      },
    );

    // 120 tasks → 100 + 20; one invalid item refused, grouped honestly.
    expect(state.chunkPosts).toHaveLength(2);
    expect(state.chunkPosts[0]!.tasks).toHaveLength(100);
    expect(state.chunkPosts[1]!.tasks).toHaveLength(20);
    expect(state.chunkPosts[0]!.boardId).toBe("board-9");
    expect(result.imported).toBe(119);
    expect(result.skipped).toBe(1);
    expect(result.attempted).toBe(120);
    expect(result.failures).toEqual([
      { status: 400, code: "INVALID_TITLE", count: 1 },
    ]);
    expect(result.idMap["t1"]).toBe("cloud-t1");
    expect(result.idMap["t3"]).toBeUndefined();
    // t2's parent rode the same call — no follow-up phase.
    expect(result.linksApplied).toBe(1);
    // a.png skipped present, b.png uploaded — same calls, not a phase.
    expect(result.filesUploaded).toBe(1);
    expect(result.filesSkippedPresent).toBe(1);
    expect(state.filePosts).toEqual(["cloud-t1:b.png"]);
    expect(seen[seen.length - 1]).toEqual([120, 120]);
    expect(readBatchCheckpoint(tempDir)).toBeNull();
  });
});
