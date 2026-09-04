/**
 * Cross-process + in-process task write lock.
 *
 * Guarantees that only one writer modifies a given task file at a time.
 * In-process: async callers are serialized via a per-path Promise chain.
 * Cross-process: O_EXCL lockfile with retry + stale-takeover by mtime.
 *
 * **Re-entrancy contract:** `fn` must NOT itself call `withTaskLock` on the
 * same `lockPath`. There is no re-entrancy guard — nested calls will deadlock.
 */
import { openSync, statSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROTO_DIR } from "./types.js";

// ── In-process serialization ───────────────────────────────────────────────
// Each lockPath gets a promise chain: caller N appends to the tail and runs
// only after N-1 has settled. This prevents same-process async interleave
// (e.g. two concurrent HTTP requests hitting the same task).
const chains = new Map<string, Promise<unknown>>();

// ── Path helpers ───────────────────────────────────────────────────────────

export function taskLockPath(projectDir: string, taskId: string): string {
  const locksDir = join(projectDir, PROTO_DIR, "tasks", ".locks");
  try {
    if (!existsSync(locksDir)) mkdirSync(locksDir, { recursive: true });
  } catch {
    /* best-effort — concurrent callers may race mkdir, which is fine */
  }
  return join(locksDir, `${taskId}.lock`);
}

// ── Cross-process lock ─────────────────────────────────────────────────────

function acquireFileLock(
  lockPath: string,
  timeoutMs: number,
  staleMs: number,
): void {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      openSync(lockPath, "wx"); // exclusive create
      return; // acquired
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Directory doesn't exist yet — create it and retry
        try {
          mkdirSync(dirname(lockPath), { recursive: true });
        } catch {
          /* another caller may have created it */
        }
        continue;
      }
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      // Check staleness: if lockfile mtime is older than staleMs, take over.
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* another process may have removed it — retry from the top */
          }
          continue; // retry immediately after removing stale lock
        }
      } catch {
        // Lockfile vanished between EEXIST and statSync — retry immediately
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Failed to acquire lock ${lockPath} within ${timeoutMs}ms`);
      }

      // Busy-wait with short sleeps (10ms is fine for task-level locks)
      // Stryker disable next-line All: timing-sensitive busy wait
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Failed to acquire lock ${lockPath} within ${timeoutMs}ms`);
      }
      // Synchronous spin-wait with deadline check (10ms granularity)
      const spinEnd = Date.now() + Math.min(10, deadline - Date.now());
      while (Date.now() < spinEnd) { /* spin */ }
    }
  }
}

function releaseFileLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* best-effort cleanup */
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Execute `fn` while holding a write lock on the given path.
 *
 * - In-process: callers are serialized via a Promise chain per lockPath.
 * - Cross-process: O_EXCL lockfile with retry + stale-takeover.
 * - The lockfile is always removed after `fn` settles (success or error).
 *
 * **Re-entrancy:** `fn` must not call `withTaskLock` on the same lockPath.
 */
export async function withTaskLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  opts?: { timeoutMs?: number; staleMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const staleMs = opts?.staleMs ?? 10_000;

  // In-process serialization: chain onto the existing tail for this path.
  const prev = chains.get(lockPath) ?? Promise.resolve();

  const resultPromise = prev.then(async () => {
    acquireFileLock(lockPath, timeoutMs, staleMs);
    try {
      return await fn();
    } finally {
      releaseFileLock(lockPath);
    }
  });

  // Update the chain tail (swallow errors so the chain doesn't break).
  chains.set(lockPath, resultPromise.catch(() => undefined));

  return resultPromise;
}
