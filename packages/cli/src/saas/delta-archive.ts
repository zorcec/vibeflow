/**
 * Pure delta-plan builder.
 *
 * Given the tasks held locally and the inventory the server already has, work
 * out which tasks/files still need to be pushed. The module is deliberately
 * side-effect free: no I/O, no clock, no randomness. The same inputs always
 * produce the same plan, which makes the push path testable and the archive
 * writer's job trivial.
 *
 * WHY hashes come from the shared package: the CLI hashes a task record and
 * the server re-hashes the stored `raw` jsonb to decide whether a task
 * changed. Both sides must serialise identically, so `hashTaskRecord` lives
 * in one place — never re-implemented here with a bare `JSON.stringify`.
 */

import { hashTaskRecord, sha256Hex } from "@vibeflow-tools/shared";

/** A task as the server knows it: its id and the hash of its record. */
export interface InventoryTask {
  id: string;
  hash: string;
}

/** A file as the server knows it. `hash` is null for legacy rows. */
export interface InventoryFile {
  taskId: string;
  name: string;
  size: number;
  hash: string | null;
}

/** Everything the server already has, per task. */
export interface Inventory {
  tasks: InventoryTask[];
  files: InventoryFile[];
}

/** A task as held locally, already assembled from the local store. */
export interface LocalTask {
  id: string;
  raw: unknown;
  files: { name: string; size: number; data: Uint8Array }[];
}

/**
 * The work that still has to be pushed.
 *
 * `tasks` holds the tasks whose record changed or that the server has never
 * seen. `unchangedTaskIds` lists tasks present on both sides with identical
 * record hashes. `droppedFileCount` counts local files that were skipped
 * because the server already holds identical bytes.
 */
export interface DeltaPlan {
  tasks: LocalTask[];
  unchangedTaskIds: string[];
  droppedFileCount: number;
}

/**
 * A skipped file keeps its entry but carries no bytes.
 *
 * WHY zero-length files are never skipped: an emptied `data` is the marker
 * that says "the server already has this file". A local file of size 0 also
 * has no bytes, so the marker would be ambiguous — chunking would then be
 * unable to tell skipped files from genuinely empty ones. Zero-length files
 * are therefore always sent (they cost nothing) and the marker stays exact.
 */
function isSkippedFile(file: { size: number; data: Uint8Array }): boolean {
  return file.size > 0 && file.data.length === 0;
}

/**
 * Find the inventory file that matches a local file.
 *
 * Legacy rows carry no hash, so name + size is all there is to go on. When a
 * hash is present the bytes must match too — the server proves identity by
 * content, and a same-name/same-size file with different bytes is a change.
 */
function findInventoryFile(
  inventoryFiles: InventoryFile[],
  taskId: string,
  name: string,
  size: number,
  data: Uint8Array,
): InventoryFile | undefined {
  const candidates = inventoryFiles.filter(
    (file) => file.taskId === taskId && file.name === name && file.size === size,
  );
  if (candidates.length === 0) return undefined;
  const withHash = candidates.find((file) => file.hash !== null);
  if (withHash) {
    // A hashed row is only the same file when the bytes hash the same way.
    return sha256Hex(data) === withHash.hash ? withHash : undefined;
  }
  return candidates[0];
}

/**
 * Build the list of tasks and files that still need to be pushed.
 *
 * A task is pushed when the server has no entry for it or when the hash of
 * its record differs from the server's. Files the server already holds
 * identically are skipped: their entry is kept with empty data so callers can
 * still see what was left out.
 */
export function buildDeltaPlan(
  local: LocalTask[],
  inventory: Inventory,
): DeltaPlan {
  const inventoryTasks = new Map(inventory.tasks.map((task) => [task.id, task]));

  const tasks: LocalTask[] = [];
  const unchangedTaskIds: string[] = [];
  let droppedFileCount = 0;

  for (const task of local) {
    const known = inventoryTasks.get(task.id);
    const hash = hashTaskRecord(task.raw);
    if (known && known.hash === hash) {
      unchangedTaskIds.push(task.id);
      continue;
    }

    const files = task.files.map((file) => {
      const match = findInventoryFile(
        inventory.files,
        task.id,
        file.name,
        file.size,
        file.data,
      );
      if (match && file.size > 0) {
        droppedFileCount += 1;
        return { name: file.name, size: file.size, data: new Uint8Array(0) };
      }
      return { name: file.name, size: file.size, data: file.data };
    });

    tasks.push({ id: task.id, raw: task.raw, files });
  }

  return { tasks, unchangedTaskIds, droppedFileCount };
}

/**
 * Split a plan into chunks of at most `maxEntriesPerChunk` tasks each.
 *
 * Every chunk carries the tasks assigned to it together with their files, so
 * concatenating the chunks reproduces the original plan. An empty plan yields
 * no chunks at all.
 */
export function chunkDeltaPlan(
  plan: DeltaPlan,
  maxEntriesPerChunk = 100,
): DeltaPlan[] {
  if (plan.tasks.length === 0) return [];
  if (maxEntriesPerChunk <= 0) {
    throw new Error("chunkDeltaPlan: maxEntriesPerChunk must be positive");
  }

  const chunks: DeltaPlan[] = [];
  for (let i = 0; i < plan.tasks.length; i += maxEntriesPerChunk) {
    const tasks = plan.tasks.slice(i, i + maxEntriesPerChunk);
    const droppedFileCount = tasks.reduce(
      (sum, task) =>
        sum + task.files.filter(isSkippedFile).length,
      0,
    );
    chunks.push({ tasks, unchangedTaskIds: [], droppedFileCount });
  }
  return chunks;
}
