import {
  readdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  statSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, basename, extname } from "node:path";
import { PROTO_DIR, FILES_DIR } from "./types.js";
import type { TaskFileRef } from "./types.js";
import { findTaskFilePath, readTaskFile, updateTask } from "./tasks.js";

export interface FileInfo {
  name: string;
  size: number;
  url: string;
  linkedPath?: string;
  createdAt?: string;
  /** True when written by the engine. Copied verbatim from the task-JSON ref; absent = user. */
  system?: boolean;
}

// ── File validation ───────────────────────────────────────────────────────────

/** Maximum filename length in characters. */
export const MAX_FILENAME_LENGTH = 255;

/** Maximum decoded file size: 50 MB in bytes (≈ base64 encoded size). */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** Extensions allowed for uploaded files (lowercase, includes leading dot). */
export const ALLOWED_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".txt",
  ".md",
  ".html",
  ".json",
  ".csv",
  ".svg",
  ".mp4",
  ".mov",
  ".zip",
]);

/**
 * Validates a filename for upload.
 * Returns false for: empty names, path separators, null bytes, control chars,
 * ".." segments, leading dots (hidden files / .linked.json), and names exceeding
 * MAX_FILENAME_LENGTH characters.
 */
export function isValidFilename(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.length > MAX_FILENAME_LENGTH) return false;
  if (name.startsWith(".")) return false; // rejects .linked.json, .env, etc.
  if (name.includes("/") || name.includes("\\")) return false;
  if (name === "." || name === ".." || name.includes("..")) return false;
  if (name.includes("\0")) return false;
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

/** Returns true when the file extension (lowercased) is in ALLOWED_FILE_EXTENSIONS. */
export function isAllowedFileExtension(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return ALLOWED_FILE_EXTENSIONS.has(ext);
}

export type FileValidationResult =
  | { valid: true }
  // `errorSuggestion` is part of the contract for the same reason
  // `VerifyAttestationResolution` carries one: this function is the only place
  // that knows WHY a filename was refused and what an acceptable one looks
  // like, so a caller given only {errorCode, errorMessage} has no recovery text
  // to forward and the refusal is unrecoverable by construction.
  | {
      valid: false;
      errorCode: string;
      errorMessage: string;
      errorSuggestion: string;
    };

/**
 * Full validation for an uploaded filename + optional buffer size.
 * Returns a tagged union so callers can distinguish the error type.
 */
export function validateFilename(
  filename: string,
  bufferSize?: number,
): FileValidationResult {
  if (!isValidFilename(filename)) {
    return {
      valid: false,
      errorCode: "INVALID_FILENAME",
      errorMessage: `Invalid filename: empty, too long (>${MAX_FILENAME_LENGTH} chars), path separator, control character, or hidden file`,
      errorSuggestion:
        "Send a bare filename: no directory part, no leading dot, no '..', and no control characters",
    };
  }
  if (!isAllowedFileExtension(filename)) {
    const ext = extname(filename).toLowerCase();
    return {
      valid: false,
      errorCode: "UNSUPPORTED_FILE_TYPE",
      errorMessage: `Unsupported file type "${ext}". Allowed: ${[...ALLOWED_FILE_EXTENSIONS].join(", ")}`,
      errorSuggestion: `Rename the file to one of the allowed extensions (${[...ALLOWED_FILE_EXTENSIONS].join(", ")}) — for a research report that means a .md name`,
    };
  }
  if (bufferSize !== undefined && bufferSize > MAX_FILE_SIZE) {
    return {
      valid: false,
      errorCode: "VALIDATION",
      errorMessage: `File too large: ${bufferSize} bytes (max ${MAX_FILE_SIZE})`,
      errorSuggestion: `Shrink the file under ${MAX_FILE_SIZE} bytes, or attach a compressed archive (.zip) instead`,
    };
  }
  return { valid: true };
}

// ── Internal constants ─────────────────────────────────────────────────────────

/** Reserved manifest filename — must not be uploaded. */
const LINKED_MANIFEST = ".linked.json";

export function getFilesDir(projectDir: string, taskId: string): string {
  return join(projectDir, PROTO_DIR, FILES_DIR, taskId);
}

export function ensureFilesDir(projectDir: string, taskId: string): void {
  mkdirSync(getFilesDir(projectDir, taskId), { recursive: true });
}

function readLinked(
  projectDir: string,
  taskId: string,
): Array<{ name: string; path: string }> {
  const manifestPath = join(getFilesDir(projectDir, taskId), LINKED_MANIFEST);
  if (!existsSync(manifestPath)) return [];
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as Array<{
      name: string;
      path: string;
    }>;
  } catch {
    return [];
  }
}

function getTaskFileRefs(projectDir: string, taskId: string): TaskFileRef[] {
  const filePath = findTaskFilePath(projectDir, taskId);
  const task = filePath ? readTaskFile(filePath) : null;
  if (!task?.files || task.files.length === 0) return [];
  return task.files;
}

/** Pure read: returns file refs without triggering migration side-effects. */
export function readTaskFileRefs(
  projectDir: string,
  taskId: string,
): TaskFileRef[] {
  return getTaskFileRefs(projectDir, taskId);
}

function setTaskFileRefs(
  projectDir: string,
  taskId: string,
  refs: TaskFileRef[],
): void {
  updateTask(projectDir, taskId, { files: refs });
}

/**
 * Engine-written filenames eligible for the one-time system-flag backfill.
 * This const is the ONLY place in the codebase where engine output is
 * recognized by name — every render/read path consults the `system` flag
 * on the ref instead (see D4 of the system-file flag plan). Lowercase;
 * compared case-insensitively because the engine always writes lowercase.
 */
const SYSTEM_FILE_NAMES = new Set([
  "baseline-element.json",
  "baseline-page.json",
  "baseline.json",
  "verify-after.json",
  "verify-diff.json",
  "verify-console.txt",
  "verify-page.html",
  "verify-all-styles.json",
  "verify-screenshot.png",
  "verify-element.html",
  "verify-page-diff.json",
]);

function migrateLegacyLinkedRefs(
  projectDir: string,
  taskId: string,
): TaskFileRef[] {
  const refs = getTaskFileRefs(projectDir, taskId);
  const manifestPath = join(getFilesDir(projectDir, taskId), LINKED_MANIFEST);
  if (!existsSync(manifestPath)) {
    return backfillSystemFlags(projectDir, taskId, refs);
  }

  const legacy = readLinked(projectDir, taskId);
  if (legacy.length === 0) {
    // Empty legacy file — remove it so this branch never runs again.
    try {
      unlinkSync(manifestPath);
    } catch {
      /* ignore */
    }
    return backfillSystemFlags(projectDir, taskId, refs);
  }

  const next = refs.slice();
  let added = false;
  for (const entry of legacy) {
    if (
      !next.find(
        (f) =>
          f.linkedPath === entry.path ||
          (f.name === entry.name && f.linkedPath),
      )
    ) {
      next.push({
        name: entry.name,
        linkedPath: entry.path,
        addedAt: new Date().toISOString(),
      });
      added = true;
    }
  }

  // Persist new entries only when something was actually added.
  if (added) {
    setTaskFileRefs(projectDir, taskId, next);
  }

  // Remove the legacy manifest file so this migration never runs again for this task.
  try {
    unlinkSync(manifestPath);
  } catch {
    /* ignore */
  }

  return backfillSystemFlags(
    projectDir,
    taskId,
    added ? getTaskFileRefs(projectDir, taskId) : next,
  );
}

/**
 * One-time backfill: stamp `system: true` onto refs whose names are in the
 * engine-written set, and create refs for ref-less on-disk files (classifying
 * them once, at this moment). Set-only — never clears a flag, never
 * duplicates refs. Persists only when something changed, so a second run is
 * a byte-no-op. Runs lazily on the write path plus the one-shot sweep.
 */
function backfillSystemFlags(
  projectDir: string,
  taskId: string,
  refs: TaskFileRef[],
): TaskFileRef[] {
  const next = refs.slice();
  let changed = false;
  for (const ref of next) {
    if (
      ref.system !== true &&
      SYSTEM_FILE_NAMES.has(ref.name.toLowerCase())
    ) {
      ref.system = true;
      changed = true;
    }
  }
  const dir = getFilesDir(projectDir, taskId);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === LINKED_MANIFEST) continue;
      if (next.find((f) => f.name === entry.name)) continue;
      const ref: TaskFileRef = {
        name: entry.name,
        addedAt: new Date().toISOString(),
      };
      if (SYSTEM_FILE_NAMES.has(entry.name.toLowerCase())) {
        ref.system = true;
      }
      next.push(ref);
      changed = true;
    }
  }
  if (changed) {
    setTaskFileRefs(projectDir, taskId, next);
    return getTaskFileRefs(projectDir, taskId);
  }
  return next;
}

export function listFiles(projectDir: string, taskId: string): FileInfo[] {
  const dir = getFilesDir(projectDir, taskId);
  const refs = readTaskFileRefs(projectDir, taskId);
  const byName = new Map<string, FileInfo>();

  for (const ref of refs) {
    if (ref.linkedPath && existsSync(ref.linkedPath)) {
      const stat = statSync(ref.linkedPath);
      byName.set(ref.name, {
        name: ref.name,
        size: stat.size,
        url: `/api/tasks/${taskId}/files/${encodeURIComponent(ref.name)}`,
        linkedPath: ref.linkedPath,
        createdAt: stat.mtime.toISOString(),
        ...(ref.system === true ? { system: true } : {}),
      });
      continue;
    }

    const uploadedPath = join(dir, ref.name);
    if (existsSync(uploadedPath)) {
      const stat = statSync(uploadedPath);
      byName.set(ref.name, {
        name: ref.name,
        size: stat.size,
        url: `/api/tasks/${taskId}/files/${encodeURIComponent(ref.name)}`,
        createdAt: stat.mtime.toISOString(),
        ...(ref.system === true ? { system: true } : {}),
      });
    }
  }

  // Backward compatibility for uploaded files that predate refs in task JSON.
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        entry.name === LINKED_MANIFEST ||
        byName.has(entry.name)
      )
        continue;
      const fullPath = join(dir, entry.name);
      const stat = statSync(fullPath);
      byName.set(entry.name, {
        name: entry.name,
        size: stat.size,
        url: `/api/tasks/${taskId}/files/${encodeURIComponent(entry.name)}`,
        createdAt: stat.mtime.toISOString(),
      });
    }
  }

  return Array.from(byName.values());
}

/** Saves binary data to .proto/files/<taskId>/<filename>. Strips path components.
 * Pass `{ system: true }` for engine-written files (verify evidence,
 * baselines); the default (absent) means a user upload. */
export function saveFile(
  projectDir: string,
  taskId: string,
  filename: string,
  data: Buffer,
  opts?: { system?: boolean },
): FileInfo {
  const safe = basename(filename);
  ensureFilesDir(projectDir, taskId);
  writeFileSync(join(getFilesDir(projectDir, taskId), safe), data);

  const refs = migrateLegacyLinkedRefs(projectDir, taskId);
  const system = opts?.system === true;
  const existing = refs.find((f) => f.name === safe && !f.linkedPath);
  if (!existing) {
    refs.push({
      name: safe,
      addedAt: new Date().toISOString(),
      ...(system ? { system: true as const } : {}),
    });
    setTaskFileRefs(projectDir, taskId, refs);
  } else if (system && existing.system !== true) {
    existing.system = true;
    setTaskFileRefs(projectDir, taskId, refs);
  }

  return {
    name: safe,
    size: data.length,
    url: `/api/tasks/${taskId}/files/${encodeURIComponent(safe)}`,
    ...(system ? { system: true as const } : {}),
  };
}

export function deleteFile(
  projectDir: string,
  taskId: string,
  filename: string,
): boolean {
  const safe = basename(filename);

  const refs = migrateLegacyLinkedRefs(projectDir, taskId);
  const idx = refs.findIndex((f) => f.name === safe);
  if (idx !== -1) {
    const [removed] = refs.splice(idx, 1);
    setTaskFileRefs(projectDir, taskId, refs);
    if (removed && !removed.linkedPath) {
      const uploadedPath = join(getFilesDir(projectDir, taskId), safe);
      if (existsSync(uploadedPath)) unlinkSync(uploadedPath);
    }
    return true;
  }

  const filePath = join(getFilesDir(projectDir, taskId), safe);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

/** Returns the absolute path if the file exists (uploaded or linked), else null. */
export function getFilePath(
  projectDir: string,
  taskId: string,
  filename: string,
): string | null {
  const safe = basename(filename);

  const linkedRef = readTaskFileRefs(projectDir, taskId).find(
    (f) => f.name === safe && f.linkedPath,
  );
  if (linkedRef?.linkedPath && existsSync(linkedRef.linkedPath))
    return linkedRef.linkedPath;

  const filePath = join(getFilesDir(projectDir, taskId), safe);
  return existsSync(filePath) ? filePath : null;
}

/** Returns the file count for a task (uploaded + linked). */
export function getFileCount(projectDir: string, taskId: string): number {
  return listFiles(projectDir, taskId).length;
}

/** One-time migration sweep: run migrateLegacyLinkedRefs for all tasks. */
export async function migrateAllLegacyLinkedRefs(
  projectDir: string,
): Promise<number> {
  const { listTasks } = await import("./tasks.js");
  const tasks = listTasks(projectDir);
  let count = 0;
  for (const task of tasks) {
    try {
      const before = JSON.stringify(readTaskFileRefs(projectDir, task.id));
      migrateLegacyLinkedRefs(projectDir, task.id);
      const after = JSON.stringify(getTaskFileRefs(projectDir, task.id));
      if (after !== before) count++;
    } catch {
      /* skip tasks that fail migration */
    }
  }
  return count;
}
