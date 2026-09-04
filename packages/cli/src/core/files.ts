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
  | { valid: false; errorCode: string; errorMessage: string };

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
    };
  }
  if (!isAllowedFileExtension(filename)) {
    const ext = extname(filename).toLowerCase();
    return {
      valid: false,
      errorCode: "UNSUPPORTED_FILE_TYPE",
      errorMessage: `Unsupported file type "${ext}". Allowed: ${[...ALLOWED_FILE_EXTENSIONS].join(", ")}`,
    };
  }
  if (bufferSize !== undefined && bufferSize > MAX_FILE_SIZE) {
    return {
      valid: false,
      errorCode: "VALIDATION",
      errorMessage: `File too large: ${bufferSize} bytes (max ${MAX_FILE_SIZE})`,
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

function readLinked(projectDir: string, taskId: string): Array<{ name: string; path: string }> {
  const manifestPath = join(getFilesDir(projectDir, taskId), LINKED_MANIFEST);
  if (!existsSync(manifestPath)) return [];
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as Array<{ name: string; path: string }>;
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
export function readTaskFileRefs(projectDir: string, taskId: string): TaskFileRef[] {
  return getTaskFileRefs(projectDir, taskId);
}

function setTaskFileRefs(projectDir: string, taskId: string, refs: TaskFileRef[]): void {
  updateTask(projectDir, taskId, { files: refs });
}

function migrateLegacyLinkedRefs(projectDir: string, taskId: string): TaskFileRef[] {
  const refs = getTaskFileRefs(projectDir, taskId);
  const manifestPath = join(getFilesDir(projectDir, taskId), LINKED_MANIFEST);
  if (!existsSync(manifestPath)) return refs;

  const legacy = readLinked(projectDir, taskId);
  if (legacy.length === 0) {
    // Empty legacy file — remove it so this branch never runs again.
    try { unlinkSync(manifestPath); } catch { /* ignore */ }
    return refs;
  }

  const next = refs.slice();
  let added = false;
  for (const entry of legacy) {
    if (!next.find((f) => f.linkedPath === entry.path || (f.name === entry.name && f.linkedPath))) {
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
  try { unlinkSync(manifestPath); } catch { /* ignore */ }

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
      });
    }
  }

  // Backward compatibility for uploaded files that predate refs in task JSON.
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === LINKED_MANIFEST || byName.has(entry.name)) continue;
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

/** Saves binary data to .proto/files/<taskId>/<filename>. Strips path components. */
export function saveFile(
  projectDir: string,
  taskId: string,
  filename: string,
  data: Buffer,
): FileInfo {
  const safe = basename(filename);
  ensureFilesDir(projectDir, taskId);
  writeFileSync(join(getFilesDir(projectDir, taskId), safe), data);

  const refs = migrateLegacyLinkedRefs(projectDir, taskId);
  if (!refs.find((f) => f.name === safe && !f.linkedPath)) {
    refs.push({ name: safe, addedAt: new Date().toISOString() });
    setTaskFileRefs(projectDir, taskId, refs);
  }

  return {
    name: safe,
    size: data.length,
    url: `/api/tasks/${taskId}/files/${encodeURIComponent(safe)}`,
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

  const linkedRef = readTaskFileRefs(projectDir, taskId).find((f) => f.name === safe && f.linkedPath);
  if (linkedRef?.linkedPath && existsSync(linkedRef.linkedPath)) return linkedRef.linkedPath;

  const filePath = join(getFilesDir(projectDir, taskId), safe);
  return existsSync(filePath) ? filePath : null;
}

/** Returns the file count for a task (uploaded + linked). */
export function getFileCount(projectDir: string, taskId: string): number {
  return listFiles(projectDir, taskId).length;
}

/** One-time migration sweep: run migrateLegacyLinkedRefs for all tasks. */
export async function migrateAllLegacyLinkedRefs(projectDir: string): Promise<number> {
  const { listTasks } = await import("./tasks.js");
  const tasks = listTasks(projectDir);
  let count = 0;
  for (const task of tasks) {
    try {
      const before = readTaskFileRefs(projectDir, task.id);
      migrateLegacyLinkedRefs(projectDir, task.id);
      const after = getTaskFileRefs(projectDir, task.id);
      if (after.length !== before.length) count++;
    } catch {
      /* skip tasks that fail migration */
    }
  }
  return count;
}
