/**
 * Batch-push checkpoint resume, integrated (ticket 8d3b2b81).
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
  createTasksInBatches,
  readBatchCheckpoint,
  batchCheckpointPath,
} from "../../src/saas/batch-push.js";
import { PROTO_DIR } from "../../src/core/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function projectTasks(n: number): Array<Record<string, unknown>> {
  // Shaped like listTasksWithPaths entries: parsed task JSON + filePath.
  return Array.from({ length: n }, (_, i) => ({
    id: `task-${i + 1}`,
    title: `Integrated task ${i + 1}`,
    status: "todo",
    filePath: join(
      ".vibeflow",
      "tasks",
      "2026-10-17",
      `task-${i + 1}.json`,
    ),
  }));
}

describe("batch checkpoint resume through a project dir", () => {
  it("killed push persists chunk progress; rerun completes the tail and clears the checkpoint", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "batch-int-"));
    try {
      const all = projectTasks(120);
      let chunkTwoDead = true;
      const postedSizes: number[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: unknown, init?: { body?: string }) => {
          const body = JSON.parse(init?.body as string) as {
            items: Array<{ id: string }>;
          };
          postedSizes.push(body.items.length);
          if (body.items[0]?.id === "task-1") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  created: body.items.length,
                  failed: 0,
                  results: body.items.map((t) => ({ id: `cloud-${t.id}` })),
                }),
            });
          }
          if (chunkTwoDead) return Promise.reject(new Error("ECONNRESET"));
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                created: body.items.length,
                failed: 0,
                results: body.items.map((t) => ({ id: `cloud-${t.id}` })),
              }),
          });
        }),
      );

      const preflight = {
        maxItems: 100,
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
        createTasksInBatches("https://x.test", "tok", "board-i", all, {
          projectDir,
          preflight,
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
      const result = await createTasksInBatches(
        "https://x.test",
        "tok",
        "board-i",
        all,
        {
          projectDir,
          preflight,
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
