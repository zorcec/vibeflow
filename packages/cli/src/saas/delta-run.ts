/**
 * Delta push: send only what the board does not already have.
 *
 * WHY this exists: a push used to re-send every task and every file, so a
 * board with 139 MB of screenshots re-uploaded 139 MB on each run and died
 * mid-way when the plan's storage cap was reached. The delta path asks the
 * board what it already holds (inventory), builds an archive of the
 * difference, and sends that instead. Old servers do not implement the
 * inventory route, so this module returns `null` and the multipart push runs
 * unchanged.
 *
 * The archive is one tar.gz per chunk, capped by COMPRESSED size.
 */

import { readFileSync } from "node:fs";

import { recordForWire, type ImportTaskInput } from "./batch-push";
import { applyEmails, resolveEmailsForRecords } from "./commit-emails";
import {
  buildDeltaPlan,
  chunkDeltaPlan,
  type Inventory,
  type LocalTask,
} from "./delta-archive";
import { probeDeltaCapability, sendDeltaArchive } from "./delta-push";

/** ~10 MiB of gzipped archive per request. */
/**
 * Input-byte budget for one archive.
 *
 * Named for INPUT bytes, not compressed bytes: the archive is gzipped before it
 * is sent, and deflate cannot expand data by more than a few bytes of framing,
 * so bounding the input bounds the wire size too. The previous name claimed the
 * opposite (and the constant was never read at all) — a budget that lies about
 * its unit is worse than no budget.
 */
export const DELTA_CHUNK_MAX_INPUT_BYTES = 10 * 1024 * 1024;
/** Tasks per chunk, before the compressed-size cap is applied. */
export const DELTA_CHUNK_MAX_TASKS = 200;

export interface DeltaRunResult {
  /** Tasks the server did not have, or had with different content. */
  imported: number;
  /** Tasks already identical on the board — not sent. */
  unchanged: number;
  /** Files already identical on the board — not sent. */
  filesDropped: number;
  /** Files actually transferred. */
  filesSent: number;
  chunks: number;
  boardId: string;
}

export interface DeltaRunOptions {
  /** Scope headers (`X-Vibeflow-Scope`) the caller already resolves. */
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  onProgress?: (phase: string, done: number, total: number) => void;
  /**
   * Called once, after planning and BEFORE the first request: how many tasks
   * will travel in how many archives. The caller prints it so the path is
   * visible — a push that silently degrades to the slower transport is exactly
   * the confusion this exists to prevent.
   * `taskIds` carries WHICH tasks travel, so the caller can word its preamble
   * with the exact send count (wording only — the plan already exists).
   */
  onPlan?: (plan: { tasks: number; chunks: number; taskIds: string[] }) => void;
  /** Where to resolve missing `authorEmail`s from git at push time. */
  gitCwd?: string;
  /** Pre-resolved emails (tests, or a caller that already ran the lookup). */
  emails?: Map<string, string>;
}

/** One inventory page as the server returns it. */
interface InventoryPage {
  deltaImport?: number;
  tasks?: { id: string; hash: string }[];
  files?: { taskId: string; name: string; size: number; hash: string | null }[];
  nextCursor?: string | null;
}

/**
 * Read the whole inventory, following `nextCursor` until it is null.
 *
 * A page without the `deltaImport` sentinel means an old server answered a
 * prefix-matched path with a foreign body — refuse rather than treat it as an
 * empty board, which would re-send everything.
 */
export async function fetchInventory(
  apiUrl: string,
  token: string,
  boardId: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<Inventory> {
  const tasks: Inventory["tasks"] = [];
  const files: Inventory["files"] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 10_000; page++) {
    const url = `${apiUrl}/api/v0/tasks/import/inventory?boardId=${encodeURIComponent(boardId)}&limit=500${
      cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
    }`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
    if (!res.ok) {
      throw new Error(`inventory failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as InventoryPage;
    if (body.deltaImport !== 1) {
      throw new Error("inventory: server does not advertise deltaImport");
    }
    tasks.push(...(body.tasks ?? []));
    files.push(...(body.files ?? []));
    cursor = body.nextCursor ?? null;
    if (cursor === null) break;
  }

  return { tasks, files };
}

/**
 * Tasks whose hash matches but which carry a file the board cannot prove it
 * already has.
 *
 * WHY this matters: `buildDeltaPlan` selects tasks by RECORD hash. A task whose
 * record is unchanged but which gained a screenshot would otherwise be skipped
 * and its file never uploaded — the record hash is not a file-set hash.
 */
function tasksWithNewFiles(local: LocalTask[], inventory: Inventory): Set<string> {
  const known = new Map<string, Map<string, string | null>>();
  for (const f of inventory.files) {
    const byName = known.get(f.taskId) ?? new Map<string, string | null>();
    byName.set(`${f.name}:${f.size}`, f.hash);
    known.set(f.taskId, byName);
  }
  const forced = new Set<string>();
  for (const task of local) {
    const byName = known.get(task.id);
    for (const file of task.files) {
      const hash = byName?.get(`${file.name}:${file.size}`);
      // Unknown on the board, or present without a hash (legacy row) and we
      // cannot prove equality — either way the safe answer is to send it.
      if (hash === undefined) {
        forced.add(task.id);
        break;
      }
    }
  }
  return forced;
}

/** Assemble the archive inputs from the on-disk files the push already listed. */
function toLocalTasks(
  inputs: ImportTaskInput[],
  emails: Map<string, string>,
): LocalTask[] {
  return inputs.map((input) => ({
    id: input.localId,
    // WHY the wire form: the local record carries runtime-only keys
    // (`filePath`, `authStateEnc`) that `recordForWire` strips before the
    // record leaves the machine. Hashing the RAW local object therefore
    // never matched what the server stored, so every push reported all
    // 1758 tasks as changed — measured against production. Hash exactly
    // what will be sent — including any email filled in below, or the same
    // mismatch returns for every task that has a commit.
    raw: applyEmails(recordForWire(input.record), emails),
    files: input.files.map((file) => {
      const data = readFileSync(file.filePath);
      return {
        name: file.name,
        size: data.byteLength,
        data: new Uint8Array(data),
        system: file.system,
      };
    }),
  }));
}

/**
 * Send the delta, or return `null` when the server has no archive route.
 *
 * Returning `null` (not throwing) is what keeps old servers working: the
 * caller falls through to the multipart path exactly as before.
 */
export async function runDeltaPush(
  apiUrl: string,
  token: string,
  boardId: string,
  inputs: ImportTaskInput[],
  opts: DeltaRunOptions,
): Promise<DeltaRunResult | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const capability = await probeDeltaCapability({
    apiUrl,
    token,
    headers: opts.headers,
    fetchImpl,
  });
  if (!capability.supported) return null;

  const local = toLocalTasks(
    inputs,
    opts.emails ??
      // One git call for the whole push. Best effort: an unavailable history
      // leaves the records untouched rather than failing the push.
      resolveEmailsForRecords(
        inputs.map((i) => recordForWire(i.record)),
        opts.gitCwd ?? process.cwd(),
      ),
  );
  const inventory = await fetchInventory(apiUrl, token, boardId, opts.headers, fetchImpl);

  // Force any task that carries a file the board cannot prove it has, so the
  // record hash cannot hide a missing attachment.
  const forced = tasksWithNewFiles(local, inventory);
  const scopedInventory: Inventory = {
    tasks: inventory.tasks.filter((t) => !forced.has(t.id)),
    files: inventory.files,
  };

  const plan = buildDeltaPlan(local, scopedInventory);
  // A forced task was excluded from the inventory to make buildDeltaPlan
  // select it; but its files must still be sent even if the board has them.
  for (const task of plan.tasks) {
    if (forced.has(task.id)) {
      for (const file of task.files) {
        if (file.size > 0 && file.data.length === 0) {
          const original = local.find((t) => t.id === task.id)?.files.find((f) => f.name === file.name);
          if (original) file.data = original.data;
        }
      }
    }
  }

  const chunks = chunkDeltaPlan(
    plan,
    DELTA_CHUNK_MAX_TASKS,
    DELTA_CHUNK_MAX_INPUT_BYTES,
  );
  const filesSent = plan.tasks.reduce(
    (sum, t) => sum + t.files.filter((f) => f.data.length > 0 || f.size === 0).length,
    0,
  );

  if (plan.tasks.length === 0) {
    return {
      imported: 0,
      unchanged: plan.unchangedTaskIds.length,
      filesDropped: plan.droppedFileCount,
      filesSent: 0,
      chunks: 0,
      boardId,
    };
  }

  opts.onPlan?.({ tasks: plan.tasks.length, chunks: chunks.length, taskIds: plan.tasks.map((t) => t.id) });
  opts.onProgress?.("delta", 0, chunks.length);
  let sent = 0;
  for (const [index, chunk] of chunks.entries()) {
    const result = await sendDeltaArchive({
      apiUrl,
      token,
      headers: opts.headers,
      boardId,
      chunks: [chunk],
      fetchImpl,
    });
    if (!result.ok) {
      // A storage refusal cannot be fixed by retrying the other transport.
      throw new Error(
        `delta push failed on chunk ${index + 1}/${chunks.length}: ${result.status ?? "network"} ${result.body}`,
      );
    }
    sent += 1;
    opts.onProgress?.("delta", sent, chunks.length);
  }

  return {
    imported: plan.tasks.length,
    unchanged: plan.unchangedTaskIds.length,
    filesDropped: plan.droppedFileCount,
    filesSent,
    chunks: sent,
    boardId,
  };
}
