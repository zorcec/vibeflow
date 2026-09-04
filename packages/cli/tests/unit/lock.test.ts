import { describe, it, expect } from "vitest";
import { withTaskLock, taskLockPath } from "../../src/core/lock.js";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("withTaskLock", () => {
  it("serializes concurrent callers on the same path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-test-"));
    const lock = taskLockPath(dir, "test-task");
    const order: number[] = [];
    const slow = (id: number, ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          order.push(id);
          resolve();
        }, ms);
      });

    await Promise.all([
      withTaskLock(lock, () => slow(1, 50)),
      withTaskLock(lock, () => slow(2, 10)),
    ]);

    // 1 must finish before 2 starts (despite 2 being faster)
    expect(order).toEqual([1, 2]);
  });

  it("removes lockfile after fn settles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-test-"));
    const lock = taskLockPath(dir, "test-task");
    await withTaskLock(lock, () => "ok");
    expect(existsSync(lock)).toBe(false);
  });

  it("removes lockfile even on error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-test-"));
    const lock = taskLockPath(dir, "test-task");
    await withTaskLock(lock, () => {
      throw new Error("boom");
    }).catch(() => {});
    expect(existsSync(lock)).toBe(false);
  });

  it("takes over a stale lockfile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-test-"));
    const lock = taskLockPath(dir, "test-task");
    // Create a stale lockfile (mtime 20s ago)
    const { writeFileSync, utimesSync } = await import("node:fs");
    writeFileSync(lock, "");
    const stale = new Date(Date.now() - 20_000);
    utimesSync(lock, stale, stale);
    expect(existsSync(lock)).toBe(true);

    // Should acquire the lock despite stale file existing
    const result = await withTaskLock(
      lock,
      () => "acquired",
      { staleMs: 10_000 },
    );
    expect(result).toBe("acquired");
    expect(existsSync(lock)).toBe(false);
  });

  it("respects timeoutMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-test-"));
    const lock = taskLockPath(dir, "test-task");
    // Create a lockfile manually (simulating another process holding it)
    const { writeFileSync: wf } = await import("node:fs");
    wf(lock, ""); // non-stale lockfile

    // Try to acquire with a short timeout — should fail
    await expect(
      withTaskLock(lock, () => "ok", { timeoutMs: 200, staleMs: 10000 }),
    ).rejects.toThrow(/Failed to acquire lock/);

    // Clean up
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(lock); } catch { /* ignore */ }
  });
});
