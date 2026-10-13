/**
 * Phase 0 conformance: manifest green against the local surface for READS.
 *
 * Boots the real API-only server in offline mode (same path as the CORS
 * suite), seeds a fixture through core (not HTTP — writes are Phase 3
 * manifest data, never executed here), and runs every runnable=local-read
 * manifest case through the api-core runner: fail-fast transport, normalized
 * comparison, explicit skip accounting for everything deferred.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { writeConfig } from "../../../src/core/config.js";
import { createTask } from "../../../src/core/tasks.js";
import { addComment } from "../../../src/core/comments.js";
import { saveFile } from "../../../src/core/files.js";
import {
  runConformance,
  RUNNER_DEFAULT_TIMEOUT_MS,
  type ManifestEntry,
  type RunnerTransport,
} from "@vibeflow-tools/api-core";

const { serve } = await import("../../../src/server/server.js");
type ServeInstance = Awaited<ReturnType<typeof serve>>;

process.env.VIBEFLOW_TELEMETRY = "0";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function makeTransport(baseUrl: string, timeoutMs: number): RunnerTransport {
  return {
    async fetchJson(method, path, options) {
      const url =
        baseUrl +
        path +
        (options?.query
          ? "?" + new URLSearchParams(options.query).toString()
          : "");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          signal: controller.signal,
          headers: options?.body ? { "Content-Type": "application/json" } : {},
          body: options?.body ? JSON.stringify(options.body) : undefined,
        });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        return { status: res.status, body };
      } catch (err) {
        // Fail fast with a named error — never hang (the 5433-stall rule).
        throw new Error(
          `conformance transport ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

describe("conformance manifest: local reads green, writes explicitly skipped", () => {
  let tempDir: string;
  let instance: ServeInstance;
  let baseUrl: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-conformance-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    const todo = createTask(tempDir, {
      title: "P0 fixture todo",
      description: "read-path fixture",
      status: "todo",
      selector: "#fixture-todo",
    });
    createTask(tempDir, {
      title: "P0 fixture in-progress",
      description: "read-path fixture",
      status: "in-progress",
      selector: "#fixture-wip",
    });
    createTask(tempDir, {
      title: "P0 fixture review",
      description: "read-path fixture",
      status: "review",
      selector: "#fixture-review",
      verified: true,
    });
    const parent = createTask(tempDir, {
      title: "P0 fixture parent",
      description: "link fixture",
      status: "todo",
      selector: "#fixture-parent",
    });
    createTask(tempDir, {
      title: "P0 fixture child",
      description: "link fixture",
      status: "todo",
      selector: "#fixture-child",
      links: [{ taskId: parent.id, type: "parent" }],
    });
    const commented = createTask(tempDir, {
      title: "P0 fixture commented",
      description: "author fixture",
      status: "todo",
      selector: "#fixture-comments",
    });
    await addComment(tempDir, commented.id, "user", "user probe", undefined, undefined, "web");
    await addComment(tempDir, commented.id, "agent", "agent probe", undefined, undefined, "cli");
    const withFiles = createTask(tempDir, {
      title: "P0 fixture files",
      description: "file fixture",
      status: "todo",
      selector: "#fixture-files",
    });
    saveFile(tempDir, withFiles.id, "note.txt", Buffer.from("hello conformance\n"));
    saveFile(tempDir, withFiles.id, "blob.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    ids["todo"] = todo.id;
    ids["commented"] = commented.id;
    ids["files"] = withFiles.id;

    const port = await getFreePort();
    instance = await serve(undefined, {
      port,
      open: false,
      projectDir: tempDir,
      _testToken: null,
      _testWorkspace: null,
    });
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30000);

  afterAll(async () => {
    await instance?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs every local-read case green and skips every write by name", async () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs", "api", "conformance-manifest.json"), "utf-8"),
    ) as { entries: ManifestEntry[] };
    const entries: ManifestEntry[] = manifest.entries.map((e) => {
      if (!e.seed) return e;
      const seed: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.seed)) {
        if (v === "<fixture todo task>") seed[k] = ids["todo"];
        else if (v === "<fixture commented task>") seed[k] = ids["commented"];
        else if (v === "<fixture file task>") seed[k] = ids["files"];
        else seed[k] = v;
      }
      // get-file's {filename} resolves to the seeded text file.
      if (e.id === "get-file") seed["filename"] = "note.txt";
      return { ...e, seed };
    });
    const report = await runConformance(
      entries,
      makeTransport(baseUrl, RUNNER_DEFAULT_TIMEOUT_MS),
    );
    expect(
      report.failed,
      `conformance failures: ${report.failed.map((f) => `${f.entryId}/${f.caseName}: ${f.detail}`).join("; ")}`,
    ).toEqual([]);
    // 9 runnable entries, 19 runnable cases — pinned so a silently
    // deselected entry fails loudly instead of shrinking coverage.
    expect(report.passed).toHaveLength(19);
    expect(report.skipped.length).toBeGreaterThan(0);
    const skippedIds = new Set(report.skipped.map((s) => s.entryId));
    for (const writeOp of [
      "create-task",
      "patch-task",
      "claim-next",
      "verify-task",
      "export-prompt",
    ]) {
      expect(skippedIds.has(writeOp), `${writeOp} must be an explicit skip`).toBe(true);
    }
    for (const s of report.skipped) {
      expect(s.detail, `${s.entryId} skip must name its phase`).toMatch(/phase \d/);
    }
  });

  it("status filter is exact and vocabulary holds on the live surface", async () => {
    const res = await fetch(`${baseUrl}/api/tasks?status=todo`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { status: string }[] };
    expect(body.tasks.length).toBeGreaterThan(0);
    for (const t of body.tasks) expect(t.status).toBe("todo");
  });

  it("comment authors read back verbatim (L1, live)", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${ids["commented"]}/comments`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: { author: string }[] };
    const authors = body.comments.map((c) => c.author).sort();
    expect(authors).toEqual(["agent", "user"]);
  });

  it("file bytes round-trip against the seeded content (live)", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${ids["files"]}/files/note.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello conformance\n");
  });

  it("fail-fast: a dead dependency rejects instead of hanging", async () => {
    const deadPort = await getFreePort();
    const transport = makeTransport(
      `http://127.0.0.1:${deadPort}`,
      RUNNER_DEFAULT_TIMEOUT_MS,
    );
    const started = Date.now();
    await expect(
      transport.fetchJson("GET", "/api/tasks", { timeoutMs: 3000 }),
    ).rejects.toThrow(/conformance transport GET \/api\/tasks failed/);
    // Refused connection surfaces in ms — nowhere near the timeout budget.
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
