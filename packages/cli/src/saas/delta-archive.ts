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

// WHY the subpath: importing the package root pulls every shared export into
// the CLI bundle, including `@paralleldrive/cuid2`, which does an unprefixed
// `require("crypto")` and crashes the ESM bundle at load time with
// "Dynamic require of \"crypto\" is not supported". This import needs only the
// two hash helpers, so it names them directly.
import { hashTaskRecord, sha256Hex } from "@vibeflow-tools/shared/delta-hash";

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
  /** `system` travels with the manifest entry so the server keeps its flag. */
  files: { name: string; size: number; data: Uint8Array; system?: boolean }[];
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
 * Input bytes a single task contributes to its archive.
 *
 * The record JSON plus every payload that will actually be written. Files whose
 * `data` is empty are markers ("the server already holds this") and travel as
 * ~0 bytes, so they must not be counted.
 */
export function taskInputBytes(task: LocalTask): number {
  let bytes = Buffer.byteLength(JSON.stringify(task.raw ?? null), "utf8");
  for (const file of task.files) bytes += file.data.byteLength;
  return bytes;
}

/**
 * Split a plan into chunks, bounded by BOTH task count and input bytes.
 *
 * `maxBytesPerChunk` is a budget on UNCOMPRESSED input, which is conservative
 * for the wire: the archive is gzipped, and deflate never expands data by more
 * than a few bytes of framing per stream. A chunk that fits here cannot exceed
 * the budget once compressed.
 *
 * WHY a byte bound at all: task count alone says nothing about size. 200 tasks
 * carrying screenshots is gigabytes; 200 tasks carrying a title is kilobytes.
 * Without this the archive path could build an arbitrarily large body in memory
 * — the failure mode is an OOM or a proxy timeout, not a clean error.
 *
 * A single task larger than the budget still ships ALONE: splitting a task
 * across archives would break the manifest (its files must ride with it), and
 * refusing would turn "one big screenshot" into a push that can never finish.
 * Every chunk therefore carries at least one task.
 *
 * Every chunk carries the tasks assigned to it together with their files, so
 * concatenating the chunks reproduces the original plan. An empty plan yields
 * no chunks at all.
 */
export function chunkDeltaPlan(
  plan: DeltaPlan,
  maxEntriesPerChunk = 100,
  maxBytesPerChunk = Number.POSITIVE_INFINITY,
): DeltaPlan[] {
  if (plan.tasks.length === 0) return [];
  if (maxEntriesPerChunk <= 0) {
    throw new Error("chunkDeltaPlan: maxEntriesPerChunk must be positive");
  }
  if (!(maxBytesPerChunk > 0)) {
    throw new Error("chunkDeltaPlan: maxBytesPerChunk must be positive");
  }

  const chunks: DeltaPlan[] = [];
  let current: LocalTask[] = [];
  let currentBytes = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push({
      tasks: current,
      unchangedTaskIds: [],
      droppedFileCount: current.reduce(
        (sum, task) => sum + task.files.filter(isSkippedFile).length,
        0,
      ),
    });
    current = [];
    currentBytes = 0;
  };

  for (const task of plan.tasks) {
    const bytes = taskInputBytes(task);
    const overCount = current.length >= maxEntriesPerChunk;
    const overBytes = current.length > 0 && currentBytes + bytes > maxBytesPerChunk;
    if (overCount || overBytes) flush();
    current.push(task);
    currentBytes += bytes;
  }
  flush();
  return chunks;
}
