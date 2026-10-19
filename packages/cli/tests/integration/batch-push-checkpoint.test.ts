/**
 * Tree-import checkpoint resume, integrated (ticket bulk-429).
 *
 * Drives the real project-dir flow — checkpoint file on disk inside a
 * temp `.vibeflow/` project, task records shaped like `listTasksWithPaths`
 * entries — with fetch stubbed per chunk: chunk one succeeds, chunk two's
 * transport dies (retries exhaust), the push throws with progress
 * persisted; the rerun (transport healed) POSTs only the missing tail and
 * clears the checkpoint. No live board, no network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  importBatchTree,
  readBatchCheckpoint,
  batchCheckpointPath,
  type ImportTaskInput,
} from "../../src/saas/batch-push.js";
import { PROTO_DIR } from "../../src/core/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function projectTasks(n: number): ImportTaskInput[] {
  // Shaped like listTasksWithPaths entries: parsed task JSON + filePath.
  return Array.from({ length: n }, (_, i) => ({
    localId: `task-${i + 1}`,
    record: {
      id: `task-${i + 1}`,
      title: `Integrated task ${i + 1}`,
      status: "todo",
      filePath: join(
        ".vibeflow",
        "tasks",
        "2026-10-17",
        `task-${i + 1}.json`,
      ),
    },
    files: [],
  }));
}

function manifestIds(init?: { body?: unknown }): string[] {
  const text = String((init?.body as FormData).get("manifest"));
  return (JSON.parse(text) as { tasks: Array<{ clientId: string }> }).tasks.map(
    (t) => t.clientId,
  );
}

function okFor(ids: string[]) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        created: ids.length,
        existing: 0,
        failed: 0,
        linksApplied: 0,
        linksFailed: 0,
        filesUploaded: 0,
        filesFailed: 0,
        filesSkipped: 0,
        results: ids.map((id) => ({ clientId: id, id: `cloud-${id}` })),
      }),
  };
}

describe("import checkpoint resume through a project dir", () => {
  it("killed push persists chunk progress; rerun completes the tail and clears the checkpoint", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "batch-int-"));
    try {
      const all = projectTasks(120);
      let chunkTwoDead = true;
      const postedSizes: number[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: unknown, init?: { body?: unknown }) => {
          const ids = manifestIds(init);
          postedSizes.push(ids.length);
          if (ids[0] === "task-1") {
            return Promise.resolve(okFor(ids));
          }
          if (chunkTwoDead) return Promise.reject(new Error("ECONNRESET"));
          return Promise.resolve(okFor(ids));
        }),
      );

      const preflight = {
        maxTasks: 100,
        maxFiles: 50,
        maxBytes: 25 * 1024 * 1024,
        plan: "free",
        openLimit: 500,
        openUsed: 0,
        openRemaining: 500,
        totalLimit: 2000,
        totalUsed: 0,
        totalRemaining: 500,
      };
      // Run one: chunk one (100) lands, chunk two (20) exhausts retries.
      await expect(
        importBatchTree("https://x.test", "tok", "board-i", all, {
          projectDir,
          preflight,
          pacingDelayMs: 0,
        }),
      ).rejects.toThrow("ECONNRESET");
      const ckpt = readBatchCheckpoint(projectDir);
      expect(ckpt?.attempted).toBe(100);
      expect(Object.keys(ckpt?.idMap ?? {})).toHaveLength(100);
      expect(existsSync(batchCheckpointPath(projectDir))).toBe(true);
      expect(existsSync(join(projectDir, PROTO_DIR))).toBe(true);

      // Run two (transport healed): only the 20-item tail POSTs.
      chunkTwoDead = false;
      postedSizes.length = 0;
      const seen: Array<[number, number]> = [];
      const result = await importBatchTree(
        "https://x.test",
        "tok",
        "board-i",
        all,
        {
          projectDir,
          preflight,
          pacingDelayMs: 0,
          onProgress: (d, t) => seen.push([d, t]),
        },
      );
      expect(postedSizes).toEqual([20]);
      expect(result.imported).toBe(20);
      expect(result.attempted).toBe(120);
      expect(Object.keys(result.idMap)).toHaveLength(120);
      expect(result.idMap["task-1"]).toBe("cloud-task-1");
      expect(result.idMap["task-101"]).toBe("cloud-task-101");
      expect(seen[0]).toEqual([100, 120]);
      expect(seen[seen.length - 1]).toEqual([120, 120]);
      expect(readBatchCheckpoint(projectDir)).toBeNull();
      expect(existsSync(batchCheckpointPath(projectDir))).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
