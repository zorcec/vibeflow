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
 * caller passed `--prefer-remote`. A second pull of an unchanged board is a
 * byte-no-op: unchanged tasks are not rewritten, identical files are not
 * touched, and `updated` is bumped only when the merge actually changed
 * something.
 *
 * WHY stage-then-merge instead of unpacking straight into the store: a
 * truncated gzip or a hash mismatch must leave ZERO writes behind. The
 * archive is extracted into `<project>/.vibeflow/.pull-tmp-<stamp>/`, verified
 * there (manifest version, entry counts, per-task hashes, per-file sha256),
 * and only then merged task-by-task into `.vibeflow/`. Any verification
 * failure deletes the temp dir and writes nothing. (A single atomic rename
 * cannot work here: the merge is per-task additive against an existing
 * store, not a whole-directory replacement — the temp dir is what makes the
 * "verify before the first write" rule enforceable.)
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
  updateTask,
} from "../core/tasks.js";
import { getFilesDir, saveFile } from "../core/files.js";
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
}

/**
 * Additive merge of one remote task record onto the local record. Rules:
 * - a key missing locally is ADDED;
 * - a conflicting key keeps the LOCAL value by default (`--prefer-remote`
 *   takes the remote one), and counts as a conflict either way;
 * - keys the local record has and the remote lacks are KEPT (never dropped);
 * - `comments[]` merge by id, `links[]` union, `sortKey` keeps the local
 *   value when the task exists (the local board's manual order is local
 *   data), and `updated` is left for the caller to bump only when changed.
 */
export function mergePullRecord(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  preferRemote: boolean,
): PullRecordMerge {
  const merged: Record<string, unknown> = { ...local };
  let changed = false;
  let conflict = false;

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
  return { merged, changed, conflict };
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

/**
 * Merge verified staging entries into `<projectDir>/.vibeflow/`. Additive
 * and never destructive: existing tasks merge field-by-field (local wins by
 * default), local-only data is never dropped, and files whose bytes differ
 * are kept locally unless `preferRemote` replaces them. `dryRun` computes
 * the same summary without writing a single byte.
 */
export function applyPullEntries(
  projectDir: string,
  staging: PullStaging,
  opts?: PullMergeOptions,
): PullMergeSummary {
  const preferRemote = opts?.preferRemote === true;
  const dryRun = opts?.dryRun === true;
  const summary = emptyPullSummary();
  let ceilingTouched = false;

  for (const task of staging.tasks) {
    const clientId = task.clientId;
    const remoteRecord: Record<string, unknown> = { ...task.record, id: clientId };
    const existingPath = findTaskFilePath(projectDir, clientId);
    if (existingPath === null) {
      // SAFETY: the archive record is a normalised local task object (it came from one); writeTaskJson normalises it again on the way to disk.
      const record = remoteRecord as unknown as Task;
      if (!record.sortKey) {
        // A new task takes the remote key verbatim when it has one; when it
        // has none, mint above the store ceiling so it lands at the bottom
        // instead of colliding mid-store.
        const ceiling = maxStoreSortKey(projectDir);
        record.sortKey =
          typeof remoteRecord.sortKey === "string" && remoteRecord.sortKey
            ? (remoteRecord.sortKey as string)
            : generateSortKeyBetween(ceiling, null);
      }
      if (!record.created) record.created = new Date().toISOString();
      if (!dryRun) writeTaskJson(projectDir, record);
      summary.added++;
      ceilingTouched = true;
      continue;
    }
    const local = readTaskFile(existingPath);
    if (!local) {
      if (!dryRun) {
        // SAFETY: the archive record is a normalised local task object (it came from one); writeTaskJsonAt serialises it back to the same file.
        const remoteTask = remoteRecord as unknown as Task;
        writeTaskJsonAt(existingPath, {
          ...remoteTask,
          created:
            typeof remoteRecord.created === "string"
              ? remoteRecord.created
              : new Date().toISOString(),
        });
      }
      summary.added++;
      ceilingTouched = true;
      continue;
    }
    const { merged, changed, conflict } = mergePullRecord(
      // SAFETY: core/tasks readTaskFile returns parsed task JSON objects; the merge treats them as plain records.
      local as unknown as Record<string, unknown>,
      remoteRecord,
      preferRemote,
    );
    if (!changed) {
      summary.unchanged++;
      continue;
    }
    if (conflict) summary.conflicts++;
    summary.merged++;
    if (
      typeof (merged as { sortKey?: unknown }).sortKey === "string" &&
      (merged as { sortKey: string }).sortKey !== local.sortKey
    ) {
      ceilingTouched = true;
    }
    if (!dryRun) {
      // SAFETY: merged starts as a spread of the local task object and only gains plain JSON fields; writeTaskJsonAt serialises it back to the same file.
      const mergedTask = merged as unknown as Task;
      writeTaskJsonAt(existingPath, {
        ...mergedTask,
        updated: new Date().toISOString(),
      });
    }
  }

  // Files ride AFTER their task record: saveFile maintains the task's
  // files[] refs, so the record must already exist (new or merged above).
  for (const file of staging.files) {
    const localPath = join(getFilesDir(projectDir, file.clientId), file.name);
    if (!existsSync(localPath)) {
      if (!dryRun) {
        saveFile(projectDir, file.clientId, file.name, file.data, {
          ...(file.system === true ? { system: true as const } : {}),
        });
        patchPullFileMimeType(projectDir, file.clientId, file.name, file.mimeType);
      }
      summary.filesWritten++;
      continue;
    }
    const localBytes = readFileSync(localPath);
    if (localBytes.equals(file.data)) {
      if (!dryRun) {
        patchPullFileMimeType(projectDir, file.clientId, file.name, file.mimeType);
      }
      summary.filesIdentical++;
      continue;
    }
    // Same name, different bytes: local wins by default (kept, reported);
    // --prefer-remote replaces the bytes (written, reported).
    if (preferRemote) {
      if (!dryRun) {
        writeFileSync(localPath, file.data);
        patchPullFileMimeType(projectDir, file.clientId, file.name, file.mimeType);
      }
      summary.filesWritten++;
    } else {
      summary.filesKept++;
    }
  }
  summary.missingBytes = staging.missingBytes.length;

  if (ceilingTouched && !dryRun) invalidateSortKeyCeiling(projectDir);
  return summary;
}

/** Patch the files[] ref's mimeType after a write, only when it differs. */
function patchPullFileMimeType(
  projectDir: string,
  clientId: string,
  name: string,
  mimeType: string | undefined,
): void {
  if (!mimeType) return;
  const filePath = findTaskFilePath(projectDir, clientId);
  const task = filePath ? readTaskFile(filePath) : null;
  if (!task || !Array.isArray(task.files)) return;
  const ref = task.files.find((f) => f.name === name);
  if (!ref || ref.mimeType === mimeType) return;
  updateTask(projectDir, clientId, {
    files: task.files.map((f) => (f.name === name ? { ...f, mimeType } : f)),
  });
}

/**
 * Full pull from an in-memory gzipped archive: stage → verify → merge.
 * Verification failures delete the temp dir and throw PullVerifyError with
 * zero store writes; merge failures are per-task writer throws (the temp
 * dir is still cleaned up). `dryRun` verifies and reports the plan without
 * writing anything.
 */
export async function runPullFromBytes(
  projectDir: string,
  gzipBytes: Buffer,
  opts?: PullMergeOptions,
): Promise<{ summary: PullMergeSummary; manifest: PullManifest }> {
  const { tempDir, treeDir } = await stagePullArchive(projectDir, gzipBytes);
  try {
    const staging = readPullStaging(treeDir);
    verifyPullStaging(staging);
    const summary = applyPullEntries(projectDir, staging, opts);
    return { summary, manifest: staging.manifest };
  } finally {
    cleanupPullStaging(tempDir);
  }
}
