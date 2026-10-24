/**
 * Pull unpack + additive merge (board archive → local store).
 *
 * WHAT: the second half of `vibeflow pull`. `saas/pull.ts` moves the bytes;
 * this module turns them into local-store writes. The archive layout is the
 * export contract (§2 of the plan): `manifest.json` first, then
 * `tasks/<cliId>.json` (the `{ clientId, record, … }` envelope the import
 * route accepts), then `files/<cliId>/<name>` (the PLAIN file bytes — the
 * server decompresses brotli rows before streaming, so these bytes hash to
 * the manifest's sha256 and the next push converges).
 *
 * WHY the merge is additive with LOCAL-WINS by default: pull must never be a
 * destructive sync. Nothing is ever deleted — no task, no file, no local-only
 * field — and on a conflicting field the local value survives unless the
 * caller passed `--prefer-remote`. The one exception is `status`: on pull,
 * `status` follows the remote record — the board is the source of truth for
 * workflow state — unless `--prefer-local` restores local-wins for it. A
 * second pull of an unchanged board is a byte-no-op: unchanged tasks are not
 * rewritten, identical files are not touched, and `updated` is bumped only
 * when the merge actually changed something.
 *
 * WHY stage-then-merge instead of unpacking straight into the store: a
 * truncated gzip or a hash mismatch must leave ZERO writes behind. The
 * archive is extracted into `<project>/.vibeflow/.pull-tmp-<stamp>/`, read
 * there, and only then merged task-by-task into `.vibeflow/`. Verification
 * (manifest version, entry counts, per-task hashes, per-file sha256) is the
 * first step of applyPullEntries — the single choke point for staged
 * writes — so any failure throws before the first store write and the temp
 * dir is deleted with nothing written. (A single atomic rename cannot work
 * here: the merge is per-task additive against an existing store, not a
 * whole-directory replacement — verify-before-the-first-write is what makes
 * the rule enforceable.)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { readTarEntries } from "@vibeflow-tools/shared/tar";
import {
  canonicalJson,
  hashTaskRecord,
  sha256Hex,
} from "@vibeflow-tools/shared/delta-hash";
import {
  findTaskFilePath,
  readTaskFile,
  writeTaskJson,
  writeTaskJsonAt,
  maxStoreSortKey,
  invalidateSortKeyCeiling,
} from "../core/tasks.js";
import { getFilesDir } from "../core/files.js";
import { invalidateChildrenIndexLocked } from "../core/task-children-index.js";
import { generateSortKeyBetween } from "@vibeflow-tools/ui/kanban";
import type { Task, TaskComment, TaskLink } from "../core/types.js";

/** Thrown when the staged archive fails verification — nothing is written. */
export class PullVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullVerifyError";
  }
}

/** Reader caps raised for a board-sized archive. The shared reader defaults
 * (1000 entries / 100 MiB total) are the IMPORT route's caps; an export may
 * legitimately carry more, so the pull passes explicit caps tied to the
 * server's documented export ceiling (50k entries, 1 GiB of file bytes). */
const PULL_TAR_LIMITS = {
  maxEntries: 60_000,
  maxEntryBytes: 600 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

// ── Manifest + staged-archive shapes ───────────────────────────────────────

export interface PullManifestTask {
  cliId: string;
  serverId?: string;
  hash?: string;
  fileCount?: number;
}

export interface PullManifestFile {
  cliId: string;
  name: string;
  size: number;
  sha256: string;
  mimeType?: string;
  system?: boolean;
  /** True = a linkedPath ref: no bytes on the server, nothing to import. */
  linked?: boolean;
}

export interface PullManifest {
  version: number;
  kind?: string;
  boardId?: string;
  boardName?: string;
  taskCount: number;
  fileCount: number;
  totalFileBytes?: number;
  tasks?: PullManifestTask[];
  files?: PullManifestFile[];
}

export interface PullTaskEntry {
  clientId: string;
  record: Record<string, unknown>;
}

export interface PullFileEntry {
  clientId: string;
  name: string;
  data: Buffer;
  mimeType?: string;
  system?: boolean;
}

export interface PullStaging {
  manifest: PullManifest;
  tasks: PullTaskEntry[];
  files: PullFileEntry[];
  /** Files the manifest marks `linked: true` — refs without server bytes. */
  missingBytes: Array<{ cliId: string; name: string }>;
}

export interface PullMergeOptions {
  /** Default false: local values win conflicts. True: remote values win. */
  preferRemote?: boolean;
  /**
   * Default false: `status` follows the remote record (the board is truth
   * for workflow state). True: the local status wins like any other
   * conflicting field. Ignored when `preferRemote` is set — that flag
   * takes the remote value for every conflicting field, status included.
   */
  preferLocal?: boolean;
  /** True: compute the summary without writing anything. */
  dryRun?: boolean;
}

export interface PullMergeSummary {
  added: number;
  merged: number;
  unchanged: number;
  /** Tasks (or files) where local and remote disagreed. */
  conflicts: number;
  filesWritten: number;
  filesIdentical: number;
  /** Local bytes kept over differing remote bytes (local-wins). */
  filesKept: number;
  /** Tasks whose `status` followed the remote record this pull. */
  statusAdopted: number;
  /**
   * Staged files that were never materialised: the merged record covers
   * the name with a `linkedPath` ref (bytes live outside the store by
   * design), or the merged record carries a files[] array that does not
   * reference the name at all (a stale server row the record disowns).
   * Neither case writes a byte, folds a ref, or bumps `updated` — and both
   * are reported here so the counts match what the pull actually did.
   */
  filesSkipped: number;
  /** Linked refs with no server bytes — kept as-is, reported. */
  missingBytes: number;
}

export function emptyPullSummary(): PullMergeSummary {
  return {
    added: 0,
    merged: 0,
    unchanged: 0,
    conflicts: 0,
    filesWritten: 0,
    filesIdentical: 0,
    filesKept: 0,
    statusAdopted: 0,
    filesSkipped: 0,
    missingBytes: 0,
  };
}

// ── Record merge (pure, unit-tested) ───────────────────────────────────────

/** Keys that must never travel from the archive into the local record. */
const PULL_IGNORED_KEYS = new Set(["filePath", "authStateEnc"]);

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge embedded `comments[]` by comment id. A local comment with the same
 * id wins by default (is replaced with `--prefer-remote`); remote-only
 * comments are appended. Id-less entries are compared structurally.
 */
export function mergePullComments(
  local: unknown,
  remote: unknown,
  preferRemote: boolean,
): { comments: TaskComment[]; changed: boolean; conflict: boolean } {
  const localList = Array.isArray(local) ? local : [];
  const remoteList = Array.isArray(remote) ? remote : [];
  const merged = localList.slice() as TaskComment[];
  const byId = new Map<string, number>();
  merged.forEach((c, i) => {
    if (isRecord(c) && typeof c.id === "string") byId.set(c.id, i);
  });
  let changed = false;
  let conflict = false;
  for (const r of remoteList) {
    if (!isRecord(r) || typeof r.id !== "string" || r.id.length === 0) {
      if (!merged.some((c) => deepEqual(c, r))) {
        // SAFETY: archive comment entries are persisted TaskComment JSON objects; the merge is representation-preserving.
        merged.push(r as unknown as TaskComment);
        changed = true;
      }
      continue;
    }
    const idx = byId.get(r.id);
    if (idx === undefined) {
      // SAFETY: same representation-preserving archive comment cast as above.
      merged.push(r as unknown as TaskComment);
      byId.set(r.id, merged.length - 1);
      changed = true;
    } else if (!deepEqual(merged[idx], r)) {
      conflict = true;
      if (preferRemote) {
        // SAFETY: same representation-preserving archive comment cast as above.
        merged[idx] = r as unknown as TaskComment;
        changed = true;
      }
    }
  }
  return { comments: merged, changed, conflict };
}

/**
 * Merge `links[]`: the union, deduped by `type|taskId`, local order first
 * with remote-only links appended. No separate link store exists locally.
 */
export function mergePullLinks(
  local: unknown,
  remote: unknown,
): { links: TaskLink[] | undefined; changed: boolean } {
  const localList = Array.isArray(local) ? (local as TaskLink[]) : [];
  const remoteList = Array.isArray(remote) ? (remote as TaskLink[]) : [];
  const seen = new Set(
    localList
      .filter((l) => l && typeof l.taskId === "string")
      .map((l) => `${l.type}|${l.taskId}`),
  );
  const merged = localList.slice();
  let changed = false;
  for (const l of remoteList) {
    if (!l || typeof l.taskId !== "string" || l.taskId.length === 0) continue;
    const key = `${l.type}|${l.taskId}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(l);
      changed = true;
    }
  }
  return { links: merged.length > 0 ? merged : undefined, changed };
}

export interface PullRecordMerge {
  merged: Record<string, unknown>;
  changed: boolean;
  conflict: boolean;
  /** True when a conflicting `status` was resolved by adopting the remote. */
  statusAdopted: boolean;
}

/**
 * Additive merge of one remote task record onto the local record. Rules:
 * - a key missing locally is ADDED;
 * - a conflicting key keeps the LOCAL value by default (`--prefer-remote`
 *   takes the remote one), and counts as a conflict either way;
 * - `status` is the exception: on pull, `status` follows the remote record
 *   — the board is the source of truth for workflow state — unless
 *   `--prefer-local` restores local-wins for it (`--prefer-remote` still
 *   takes the remote value for every conflicting field, status included);
 * - keys the local record has and the remote lacks are KEPT (never dropped);
 * - `comments[]` merge by id, `links[]` union, `sortKey` keeps the local
 *   value when the task exists (the local board's manual order is local
 *   data), and `updated` is left for the caller to bump only when changed.
 */
export function mergePullRecord(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  preferRemote: boolean,
  preferLocal = false,
): PullRecordMerge {
  const merged: Record<string, unknown> = { ...local };
  let changed = false;
  let conflict = false;
  let statusAdopted = false;

  for (const [key, remoteValue] of Object.entries(remote)) {
    if (PULL_IGNORED_KEYS.has(key)) continue;
    if (key === "updated") continue; // bumped once at the end, only when changed
    if (key === "comments") {
      const localComments = local.comments;
      const result = mergePullComments(localComments, remoteValue, preferRemote);
      if (result.changed) {
        merged.comments = result.comments;
        changed = true;
      } else if (!("comments" in merged) && Array.isArray(remoteValue)) {
        merged.comments = result.comments;
        changed = true;
      }
      if (result.conflict) conflict = true;
      continue;
    }
    if (key === "links") {
      const result = mergePullLinks(local.links, remoteValue);
      if (result.changed) {
        if (result.links === undefined) delete merged.links;
        else merged.links = result.links;
        changed = true;
      } else if (!("links" in merged) && result.links !== undefined) {
        merged.links = result.links;
        changed = true;
      }
      continue;
    }
    if (key === "status") {
      if (!(key in merged)) {
        merged[key] = remoteValue;
        changed = true;
      } else if (!deepEqual(merged[key], remoteValue)) {
        conflict = true;
        if (preferRemote || !preferLocal) {
          merged[key] = remoteValue;
          changed = true;
          statusAdopted = true;
        }
      }
      continue;
    }
    if (key === "sortKey") {
      // The local board's manual column order must not be lost: an existing
      // task keeps its key, and only a NEW task takes the remote key verbatim
      // (handled by the caller — here the local key always exists).
      if (merged.sortKey === undefined && typeof remoteValue === "string") {
        merged.sortKey = remoteValue;
        changed = true;
      } else if (
        merged.sortKey !== undefined &&
        typeof remoteValue === "string" &&
        merged.sortKey !== remoteValue
      ) {
        conflict = true;
        if (preferRemote) {
          merged.sortKey = remoteValue;
          changed = true;
        }
      }
      continue;
    }
    if (!(key in merged)) {
      merged[key] = remoteValue;
      changed = true;
    } else if (!deepEqual(merged[key], remoteValue)) {
      conflict = true;
      if (preferRemote) {
        merged[key] = remoteValue;
        changed = true;
      }
    }
  }
  return { merged, changed, conflict, statusAdopted };
}

// ── Stage: gunzip + tar → temp dir ─────────────────────────────────────────

/** Extract one gzipped pull archive into a fresh temp dir under the project.
 * Throws (PullVerifyError subclasses welcome, plain Errors for I/O and gzip
 * failures alike) WITHOUT touching `.vibeflow/tasks/` — the caller verifies
 * the tree before the first store write. */
export async function stagePullArchive(
  projectDir: string,
  gzipBytes: Buffer,
): Promise<{ tempDir: string; treeDir: string }> {
  const tempDir = join(
    projectDir,
    ".vibeflow",
    `.pull-tmp-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  const treeDir = join(tempDir, "tree");
  mkdirSync(treeDir, { recursive: true });
  let plain: Buffer;
  try {
    plain = gunzipSync(gzipBytes);
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new PullVerifyError(
      `Pull archive is not valid gzip: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const source = Readable.from([plain]) as NodeJS.ReadableStream;
    for await (const entry of readTarEntries(source, PULL_TAR_LIMITS)) {
      // The reader already refuses absolute paths and `..`; re-join here is
      // defence in depth so an entry can never escape the staging dir.
      const target = join(treeDir, entry.path);
      if (!target.startsWith(treeDir + "/")) {
        throw new PullVerifyError(
          `Pull archive entry escapes the staging dir: ${entry.path}`,
        );
      }
      mkdirSync(dirname(target), { recursive: true });
      const { createWriteStream } = await import("node:fs");
      await pipeline(entry.stream as NodeJS.ReadableStream, createWriteStream(target));
    }
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    if (err instanceof PullVerifyError) throw err;
    throw new PullVerifyError(
      `Pull archive is truncated or corrupt: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { tempDir, treeDir };
}

/** Remove a staging dir. Best-effort: a leftover temp dir is never a
 * correctness problem (it lives outside `tasks/` and the next pull ignores
 * dot-dirs), but a failed pull must not accumulate them. */
export function cleanupPullStaging(tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ── Read + verify the staged tree ──────────────────────────────────────────

/** Parse one `tasks/<cliId>.json`: the `{ clientId, record, … }` envelope
 * the export emits (the same shape the import route accepts), falling back
 * to a bare record for forward tolerance. */
export function parsePullTaskFile(
  clientId: string,
  text: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PullVerifyError(
      `Pull archive task ${clientId} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (isRecord(parsed) && isRecord(parsed.record)) {
    return parsed.record;
  }
  if (isRecord(parsed)) return parsed;
  throw new PullVerifyError(`Pull archive task ${clientId} is not an object`);
}

function listFilesRecursive(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs, base));
    else if (entry.isFile()) out.push(abs.slice(base.length + 1));
  }
  return out.sort();
}

export function readPullStaging(treeDir: string): PullStaging {
  const manifestPath = join(treeDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new PullVerifyError("Pull archive has no manifest.json");
  }
  let manifest: PullManifest;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!isRecord(parsed)) throw new Error("manifest is not an object");
    // SAFETY: parsed JSON was just narrowed to a record; PullManifest is the documented archive shape validated field-by-field in verifyPullStaging.
    manifest = parsed as unknown as PullManifest;
  } catch (err) {
    if (err instanceof PullVerifyError) throw err;
    throw new PullVerifyError(
      `Pull archive manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tasks: PullTaskEntry[] = [];
  for (const rel of listFilesRecursive(join(treeDir, "tasks"), join(treeDir, "tasks"))) {
    if (!rel.endsWith(".json")) continue;
    const clientId = basename(rel, ".json");
    tasks.push({
      clientId,
      record: parsePullTaskFile(clientId, readFileSync(join(treeDir, "tasks", rel), "utf-8")),
    });
  }
  // Deterministic merge order: parents first is the server's emission order,
  // but a byte-stable sort keeps re-pulls diff-identical regardless of tar
  // order. (Parent links resolve by id lookup, not by write order — the local
  // store has no write-order dependency — so sorting never breaks the tree.)
  tasks.sort((a, b) => (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0));

  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const byRef = new Map(
    manifestFiles.map((f) => [`${f.cliId}/${f.name}`, f]),
  );
  const files: PullFileEntry[] = [];
  const missingBytes: Array<{ cliId: string; name: string }> = [];
  for (const rel of listFilesRecursive(join(treeDir, "files"), join(treeDir, "files"))) {
    const slash = rel.indexOf("/");
    if (slash === -1) continue;
    const clientId = rel.slice(0, slash);
    const name = rel.slice(slash + 1);
    const ref = byRef.get(`${clientId}/${name}`);
    files.push({
      clientId,
      name,
      data: readFileSync(join(treeDir, "files", rel)),
      ...(ref?.mimeType ? { mimeType: ref.mimeType } : {}),
      ...(ref?.system === true ? { system: true as const } : {}),
    });
  }
  for (const f of manifestFiles) {
    if (f.linked === true) missingBytes.push({ cliId: f.cliId, name: f.name });
  }
  return { manifest, tasks, files, missingBytes };
}

/**
 * Verify the staged tree BEFORE the first store write. Every failure throws
 * PullVerifyError and the caller deletes the temp dir with zero writes:
 * version, entry counts, per-task id/hash agreement, per-file sha256/size,
 * and the byte total. Fields the manifest omits are skipped, never assumed.
 */
export function verifyPullStaging(staging: PullStaging): void {
  const { manifest, tasks, files } = staging;
  if (manifest.version !== 1) {
    throw new PullVerifyError(
      `Unsupported pull archive version: ${JSON.stringify(manifest.version)} (expected 1)`,
    );
  }
  if (typeof manifest.taskCount === "number" && tasks.length !== manifest.taskCount) {
    throw new PullVerifyError(
      `Pull archive task count mismatch: manifest says ${manifest.taskCount}, archive holds ${tasks.length}`,
    );
  }
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const expectedFileEntries = manifestFiles.filter((f) => f.linked !== true).length;
  if (typeof manifest.fileCount === "number" && files.length !== expectedFileEntries) {
    throw new PullVerifyError(
      `Pull archive file count mismatch: manifest says ${manifest.fileCount}, archive holds ${files.length}`,
    );
  }
  const byManifestTask = new Map(
    (Array.isArray(manifest.tasks) ? manifest.tasks : []).map((t) => [t.cliId, t]),
  );
  for (const task of tasks) {
    const recordId = task.record.id;
    if (recordId !== task.clientId) {
      throw new PullVerifyError(
        `Pull archive task id mismatch: path says ${task.clientId}, record says ${JSON.stringify(recordId)}`,
      );
    }
    const listed = byManifestTask.get(task.clientId);
    if (listed?.hash !== undefined && hashTaskRecord(task.record) !== listed.hash) {
      throw new PullVerifyError(
        `Pull archive task ${task.clientId} fails its manifest hash — the archive is corrupt`,
      );
    }
  }
  const byManifestFile = new Map(
    manifestFiles.map((f) => [`${f.cliId}/${f.name}`, f]),
  );
  let totalBytes = 0;
  for (const file of files) {
    const listed = byManifestFile.get(`${file.clientId}/${file.name}`);
    const digest = sha256Hex(file.data);
    if (listed !== undefined) {
      if (listed.sha256 !== undefined && listed.sha256 !== digest) {
        throw new PullVerifyError(
          `Pull archive file ${file.clientId}/${file.name} fails its manifest sha256 — the archive is corrupt`,
        );
      }
      if (listed.size !== undefined && listed.size !== file.data.length) {
        throw new PullVerifyError(
          `Pull archive file ${file.clientId}/${file.name} size mismatch: manifest says ${listed.size}, archive holds ${file.data.length}`,
        );
      }
    }
    totalBytes += file.data.length;
  }
  if (manifest.totalFileBytes !== undefined && totalBytes !== manifest.totalFileBytes) {
    throw new PullVerifyError(
      `Pull archive byte total mismatch: manifest says ${manifest.totalFileBytes}, archive holds ${totalBytes}`,
    );
  }
}

// ── Merge the verified staging into the local store ────────────────────────

/** One task's planned store write. `record` is the exact object to
 * serialise — built (never mutated in place) from the staged archive entry
 * — and `filePath` is null only for brand-new tasks, where writeTaskJson
 * picks the date subdir. `unchanged` plans carry no record and write
 * nothing: an unchanged task stays byte-identical on disk. */
interface PullTaskPlan {
  clientId: string;
  kind: "new" | "rewrite" | "unchanged" | "quarantined";
  filePath: string | null;
  record: Record<string, unknown> | null;
  conflict: boolean;
  ceilingTouched: boolean;
}

/** One staged file's planned fate. `needsRef` carries the files[] entry the
 * stored task record must contain for bytes this pull writes; it is folded
 * into the task plan BEFORE the first write so the task file is written at
 * most once and the write is counted. `skip` never writes a byte, folds no
 * ref, and bumps no `updated` (see the linked/stale rule in Phase 1b). */
interface PullFilePlan {
  file: PullFileEntry;
  safeName: string;
  action: "write" | "identical" | "keep" | "skip";
  needsRef: { clientId: string; serverRef: Record<string, unknown> | null } | null;
}

/**
 * Merge staged entries into `<projectDir>/.vibeflow/`. Additive and never
 * destructive: existing tasks merge field-by-field (local wins by default,
 * except `status`, which follows the remote record unless `--prefer-local`
 * restores local-wins for it), local-only data is never dropped, and files
 * whose bytes differ are kept locally unless `preferRemote` replaces them.
 * `dryRun` computes the same summary without writing a single byte.
 *
 * ATOMICITY: verification runs FIRST, inside this function — not just in
 * runPullFromBytes — because this is the only writer of staged data into
 * the live store. Any manifest/task/file mismatch throws PullVerifyError
 * before the first store write, so a corrupt archive leaves the store
 * byte-identical no matter which entry point the caller used. Past that
 * point the merge is planned whole (every task record, every file fate,
 * every files[] ref the plan needs) and only then executed, so a task file
 * is never written twice and every write is counted exactly once.
 *
 * FIDELITY: the pull reproduces the server record faithfully. Manifest-only
 * metadata (notably the file-entry `mimeType`) is never invented into the
 * stored task: when the server record carries no `mimeType`, none is
 * added, and `updated` is bumped only for tasks the merge actually changed
 * — an unchanged pull is a byte-no-op, which is what keeps the next push
 * converged instead of re-uploading pulled tasks. Staged files the merged
 * record disowns (a `linkedPath` cover, or no files[] reference at all)
 * are SKIPPED: no byte may be written for a path the record sanctions
 * nothing for, and the skip is counted so the summary matches the disk.
 */
export function applyPullEntries(
  projectDir: string,
  staging: PullStaging,
  opts?: PullMergeOptions,
): PullMergeSummary {
  verifyPullStaging(staging);

  const preferRemote = opts?.preferRemote === true;
  const preferLocal = opts?.preferLocal === true;
  const dryRun = opts?.dryRun === true;
  const summary = emptyPullSummary();

  // ── Phase 1: plan every task write (reads only, no writes) ──
  const taskPlans: PullTaskPlan[] = [];
  for (const task of staging.tasks) {
    const clientId = task.clientId;
    const remoteRecord: Record<string, unknown> = { ...task.record, id: clientId };
    const existingPath = findTaskFilePath(projectDir, clientId);
    if (existingPath === null) {
      const record: Record<string, unknown> = { ...remoteRecord };
      if (typeof record.sortKey !== "string" || record.sortKey.length === 0) {
        // A new task takes the remote key verbatim when it has one; when it
        // has none, mint above the store ceiling so it lands at the bottom
        // instead of colliding mid-store.
        const ceiling = maxStoreSortKey(projectDir);
        record.sortKey =
          typeof remoteRecord.sortKey === "string" && remoteRecord.sortKey
            ? (remoteRecord.sortKey as string)
            : generateSortKeyBetween(ceiling, null);
      }
      if (typeof record.created !== "string" || record.created.length === 0) {
        record.created = new Date().toISOString();
      }
      taskPlans.push({
        clientId,
        kind: "new",
        filePath: null,
        record,
        conflict: false,
        ceilingTouched: true,
      });
      continue;
    }
    const local = readTaskFile(existingPath);
    if (!local) {
      // A quarantined slot may contain deliberate data this reader cannot
      // express. Pull copies; only explicit normalisation may repair it.
      taskPlans.push({ clientId, kind: "quarantined", filePath: existingPath,
        record: null, conflict: true, ceilingTouched: false });
      continue;
    }
    const { merged, changed, conflict, statusAdopted } = mergePullRecord(
      // SAFETY: core/tasks readTaskFile returns parsed task JSON objects; the merge treats them as plain records.
      local as unknown as Record<string, unknown>,
      remoteRecord,
      preferRemote,
      preferLocal,
    );
    if (statusAdopted) summary.statusAdopted++;
    if (!changed) {
      taskPlans.push({
        clientId,
        kind: "unchanged",
        filePath: existingPath,
        record: null,
        conflict,
        ceilingTouched: false,
      });
      continue;
    }
    taskPlans.push({
      clientId,
      kind: "rewrite",
      filePath: existingPath,
      // `updated` is stamped at execute time, once, for genuinely changed tasks only.
      record: { ...merged },
      conflict,
      ceilingTouched:
        typeof (merged as { sortKey?: unknown }).sortKey === "string" &&
        (merged as { sortKey: string }).sortKey !== local.sortKey,
    });
  }
  const planByClientId = new Map(taskPlans.map((p) => [p.clientId, p]));

  // ── Phase 1b: plan every file fate (reads only, no writes) ──
  // Files ride AFTER their task record: the record must already exist (new
  // or merged above) before bytes land, so refs always describe reality.
  //
  // LINKED/STALE RULE: the merged record decides what is materialisable —
  // the disk does not. A staged file is skipped (never written, never
  // folded as a ref, never counted as written) when the task's post-merge
  // record covers its name with a `linkedPath` ref (bytes live outside the
  // store by design — writing them invents file content no pull can
  // converge away from), or when the record carries a files[] array that
  // does not reference the name at all (a stale server row the record
  // disowns — folding a ref for it would create a local-only entry the
  // next verify flags as `file-missing-raw`). Skipping holds regardless of
  // `--prefer-remote`: that flag settles conflicting VALUES, it never
  // overrules the record about what EXISTS. A record with NO files[] array
  // at all is silent (e.g. synthesised web-created tasks), so its staged
  // files materialise exactly as before.
  const filePlans: PullFilePlan[] = [];
  for (const file of staging.files) {
    // saveFile parity: the on-disk name is the bare filename, so a staged
    // nested name can never escape the task's files dir or throw mid-apply.
    const safeName = basename(file.name);
    if (planByClientId.get(file.clientId)?.kind === "quarantined") {
      filePlans.push({ file, safeName, action: "skip", needsRef: null });
      continue;
    }
    const coverage = plannedFilesCoverage(planByClientId.get(file.clientId));
    if (coverage !== null && isUnmaterialisable(coverage, file.name)) {
      filePlans.push({ file, safeName, action: "skip", needsRef: null });
      continue;
    }
    const localPath = join(getFilesDir(projectDir, file.clientId), safeName);
    let action: PullFilePlan["action"];
    if (!existsSync(localPath)) {
      action = "write";
    } else if (readFileSync(localPath).equals(file.data)) {
      action = "identical";
    } else {
      // Same name, different bytes: local wins by default (kept, reported);
      // --prefer-remote replaces the bytes (written, reported).
      action = preferRemote ? "write" : "keep";
    }
    let needsRef: PullFilePlan["needsRef"] = null;
    if (action === "write") {
      const plan = planByClientId.get(file.clientId);
      const refs = readPlannedFileRefs(plan);
      if (
        plan !== undefined &&
        refs !== null &&
        !refs.some((f) => typeof f.name === "string" && f.name === safeName)
      ) {
        // Bytes are about to land with no files[] entry describing them.
        // Fold the ref into the task plan now — the task file is written at
        // most once, and the write is counted. The server's own ref entry is
        // reproduced verbatim when the record carries one; otherwise a
        // minimal entry (never an invented mimeType).
        const remoteFiles = stagedFilesFor(staging, file.clientId);
        const serverEntry = remoteFiles.find((f) => f.name === safeName);
        needsRef = {
          clientId: file.clientId,
          serverRef: serverEntry ?? null,
        };
      }
    }
    filePlans.push({ file, safeName, action, needsRef });
  }

  // Fold needed refs into task plans before the first write. An otherwise
  // unchanged task that gains a ref IS a write, and is counted as merged.
  for (const fp of filePlans) {
    if (!fp.needsRef) continue;
    const plan = planByClientId.get(fp.needsRef.clientId);
    if (!plan) continue;
    const ref: Record<string, unknown> = fp.needsRef.serverRef
      ? { ...fp.needsRef.serverRef, name: fp.safeName }
      : { name: fp.safeName, addedAt: new Date().toISOString() };
    if (fp.needsRef.serverRef?.system === true) ref.system = true;
    if (plan.kind === "unchanged") {
      const local = plan.filePath ? readTaskFile(plan.filePath) : null;
      // SAFETY: local was just read from the plan's own filePath; the spread preserves its parsed task JSON shape.
      const base = (local as unknown as Record<string, unknown> | null) ?? {};
      const files = Array.isArray(base.files)
        ? [...(base.files as unknown[]), ref]
        : [ref];
      plan.kind = "rewrite";
      plan.record = { ...base, files };
      plan.ceilingTouched = false;
    } else if (plan.record) {
      const files = Array.isArray(plan.record.files)
        ? [...(plan.record.files as unknown[]), ref]
        : [ref];
      plan.record = { ...plan.record, files };
    }
  }

  // ── Phase 2: execute exactly the plan ──
  let ceilingTouched = false;
  for (const plan of taskPlans) {
    if (plan.conflict) summary.conflicts++;
    if (plan.kind === "unchanged" || plan.kind === "quarantined") {
      summary.unchanged++;
      continue;
    }
    if (plan.kind === "new") {
      if (!dryRun && plan.record) {
        if (plan.filePath === null) {
          // SAFETY: the planned record derives from the normalised archive record plus pull defaults; writeTaskJson persists it.
          writeTaskJson(projectDir, plan.record as unknown as Task);
        } else {
          // SAFETY: same normalised-archive-record origin as above, restored into its existing slot.
          writeTaskJsonAt(plan.filePath, plan.record as unknown as Task);
        }
      }
      summary.added++;
    } else {
      if (!dryRun && plan.record && plan.filePath) {
        // SAFETY: record starts as a spread of the local task object and only gains plain JSON fields; writeTaskJsonAt serialises it back to the same file.
        const mergedTask = plan.record as unknown as Task;
        writeTaskJsonAt(plan.filePath, {
          ...mergedTask,
          updated: new Date().toISOString(),
        });
      }
      summary.merged++;
    }
    if (plan.ceilingTouched) ceilingTouched = true;
  }

  for (const fp of filePlans) {
    if (fp.action === "skip") {
      // Linked or stale: the record sanctions no bytes for this name, so
      // none are written, no ref is folded, and no task `updated` moves.
      // Counted separately so the summary matches what hit the disk.
      summary.filesSkipped++;
      continue;
    }
    if (fp.action === "identical") {
      // Identical bytes are not touched: no write, no ref patch, no
      // `updated` bump. An unchanged pull stays byte-identical.
      summary.filesIdentical++;
      continue;
    }
    if (fp.action === "keep") {
      summary.filesKept++;
      continue;
    }
    if (!dryRun) {
      mkdirSync(getFilesDir(projectDir, fp.file.clientId), { recursive: true });
      writeFileSync(
        join(getFilesDir(projectDir, fp.file.clientId), fp.safeName),
        fp.file.data,
      );
    }
    summary.filesWritten++;
  }
  summary.missingBytes = staging.missingBytes.length;

  if (ceilingTouched && !dryRun) invalidateSortKeyCeiling(projectDir);
  // A pull can add, change, or drop parent edges: invalidate the children
  // index (under lock, ordered against concurrent publishes) so the next
  // local cascade rebuilds once instead of trusting pre-pull edges.
  if (!dryRun && summary.added + summary.merged > 0) {
    invalidateChildrenIndexLocked(projectDir);
  }
  return summary;
}

/** files[] refs of a task plan's post-merge record (pure read, no writes).
 * Returns null when no record exists to attach a ref to (staged file for an
 * unknown task: bytes still land, orphaned, exactly as before). */
function readPlannedFileRefs(
  plan: PullTaskPlan | undefined,
): Array<{ name?: unknown }> | null {
  if (!plan) return null;
  // SAFETY: readTaskFile returns parsed task JSON objects; the ref check below only reads the files[] array shape.
  const stored = (plan.filePath ? readTaskFile(plan.filePath) : null) as unknown as Record<string, unknown> | null;
  const record: Record<string, unknown> | null = plan.record ?? stored;
  if (!record || !Array.isArray(record.files)) {
    // No files[] array yet: a ref is needed only when the plan will write
    // one... a missing array means the first ref must create it. Report the
    // empty list so the caller adds it; a null record (unknown task) stays null.
    return record ? [] : null;
  }
  return record.files as Array<{ name?: unknown }>;
}

/**
 * What the task plan's post-merge record says about attachments.
 *
 * `null` = no record to consult (staged file for an unknown task: bytes
 * still land, orphaned, exactly as before). `present: false` = the record
 * is silent about files (no files[] array, or an empty one — the
 * normalizer always emits `files: []`, so an empty array says nothing),
 * and staged files materialise exactly as before. `present: true` = the
 * record lists attachments but the staged name is not among them, or is
 * among them only as a `linkedPath` ref: only a same-name entry WITHOUT
 * `linkedPath` may materialise.
 */
interface PlannedFilesCoverage {
  present: boolean;
  entries: Array<{ name?: unknown; linkedPath?: unknown }>;
}

function plannedFilesCoverage(
  plan: PullTaskPlan | undefined,
): PlannedFilesCoverage | null {
  if (!plan) return null;
  // SAFETY: readTaskFile returns parsed task JSON objects; only the files[]
  // array shape is read below. Same record source as readPlannedFileRefs so
  // the skip decision and the ref fold can never disagree about refs.
  const stored = (plan.filePath ? readTaskFile(plan.filePath) : null) as unknown as Record<string, unknown> | null;
  const record: Record<string, unknown> | null = plan.record ?? stored;
  if (!record) return null;
  if (!Array.isArray(record.files) || record.files.length === 0) {
    return { present: false, entries: [] };
  }
  return {
    present: true,
    entries: (record.files as unknown[]).filter(
      (f): f is { name?: unknown; linkedPath?: unknown } =>
        typeof f === "object" && f !== null && !Array.isArray(f),
    ),
  };
}

/**
 * True when the staged file must never be materialised (linked/stale rule).
 *
 * A same-name entry WITH `linkedPath` means the bytes live outside the
 * store by design — writing them invents content the record disowns. No
 * same-name entry at all, while the record carries a files[] array, means
 * a stale server row the record disowns — same answer. In both cases no
 * byte may be written for a path whose record sanctions nothing.
 */
function isUnmaterialisable(coverage: PlannedFilesCoverage, stagedName: string): boolean {
  if (!coverage.present) return false;
  const same = coverage.entries.filter(
    (e) => typeof e.name === "string" && e.name === stagedName,
  );
  if (same.some((e) => typeof e.linkedPath === "string" && e.linkedPath.length > 0)) {
    return true;
  }
  return same.length === 0;
}

/** The staged remote record's files[] entries for one task (faithful source
 * for refs this pull writes bytes for — never invented, only reproduced). */
function stagedFilesFor(
  staging: PullStaging,
  clientId: string,
): Array<Record<string, unknown>> {
  const entry = staging.tasks.find((t) => t.clientId === clientId);
  const files = (entry?.record as Record<string, unknown> | undefined)?.files;
  if (!Array.isArray(files)) return [];
  return files.filter(isRecord).map((f) => f as Record<string, unknown>);
}

/**
 * Full pull from an in-memory gzipped archive: stage → read → verify-and-merge.
 * Verification is the first step of applyPullEntries, so every mismatch
 * throws PullVerifyError with zero store writes (the temp dir is still
 * cleaned up); only I/O failures during the planned write phase can leave
 * partial writes, and those surface as plain Errors, never as verify
 * failures. `dryRun` verifies and reports the plan without writing anything.
 */
export async function runPullFromBytes(
  projectDir: string,
  gzipBytes: Buffer,
  opts?: PullMergeOptions,
): Promise<{ summary: PullMergeSummary; manifest: PullManifest }> {
  const { tempDir, treeDir } = await stagePullArchive(projectDir, gzipBytes);
  try {
    const staging = readPullStaging(treeDir);
    const summary = applyPullEntries(projectDir, staging, opts);
    return { summary, manifest: staging.manifest };
  } finally {
    cleanupPullStaging(tempDir);
  }
}
