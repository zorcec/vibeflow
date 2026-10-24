import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { listTasksWithPaths } from "./tasks.js";
import { taskLockPath, withFileLockSync } from "./lock.js";

export function assertRemovableTag(tag: unknown): string {
  if (typeof tag !== "string" || tag.trim().length === 0) {
    throw new Error("tag must be a non-empty string");
  }
  if (tag.length > 50) throw new Error("tag must be at most 50 characters");
  return tag;
}

/**
 * One snapshot scan, then sorted per-task locks held through staging, replace
 * and rollback. Re-read under lock so a single-task edit cannot be overwritten.
 * Tags do not affect the children index (which contains only parent edges).
 *
 * Owner-approved filesystem batch (uvbpv6ax): stage every replacement and
 * byte-exact backup before committing. Exceptions roll back; process death
 * mid-rename can leave a partial batch, and failed rollback is reported.
 * Like writeTaskFile, rename is atomic per file, without fsync. Existing lock
 * stale-takeover rules still apply; this is not a crash-atomic transaction.
 */
export function removeTagFromAllTasks(projectDir: string, tag: unknown): { removed: number } {
  const clean = assertRemovableTag(tag);
  const candidates = listTasksWithPaths(projectDir)
    .filter(task => (task.tags ?? []).includes(clean))
    .sort((a, b) => a.id.localeCompare(b.id));

  function locked(index: number): { removed: number } {
    if (index < candidates.length) {
      return withFileLockSync(taskLockPath(projectDir, candidates[index].id), () => locked(index + 1));
    }
    const staged: Array<{ path: string; next: string; backup: string }> = [];
    const replaced: typeof staged = [];
    let preserveBackups = false;
    const suffix = randomBytes(8).toString("hex");
    const updated = new Date().toISOString();
    try {
      for (const task of candidates) {
        // A deleted task is no longer in scope; newly tagged tasks after the
        // snapshot belong to the next operation, just like any board snapshot.
        if (!existsSync(task.filePath)) continue;
        const original = readFileSync(task.filePath, "utf-8");
        const current = JSON.parse(original);
        if (!Array.isArray(current.tags) || !current.tags.includes(clean)) continue;
        const entry = {
          path: task.filePath,
          next: `${task.filePath}.${suffix}.next.tmp`,
          backup: `${task.filePath}.${suffix}.backup.tmp`,
        };
        staged.push(entry);
        writeFileSync(entry.backup, original, "utf-8");
        writeFileSync(entry.next, JSON.stringify({
          ...current,
          tags: current.tags.filter((value: unknown) => value !== clean),
          updated,
        }, null, 2), "utf-8");
      }
      for (const entry of staged) {
        renameSync(entry.next, entry.path);
        replaced.push(entry);
      }
      return { removed: replaced.length };
    } catch (error) {
      const failures: unknown[] = [];
      for (const entry of replaced.reverse()) {
        try { renameSync(entry.backup, entry.path); }
        catch (rollbackError) { failures.push(rollbackError); }
      }
      if (failures.length) {
        preserveBackups = true;
        throw new AggregateError([error, ...failures], "Tag removal failed and rollback was incomplete");
      }
      throw error;
    } finally {
      for (const entry of staged) {
        for (const path of preserveBackups ? [entry.next] : [entry.next, entry.backup]) {
          try { unlinkSync(path); } catch { /* already renamed, or best-effort cleanup */ }
        }
      }
    }
  }
  return locked(0);
}
