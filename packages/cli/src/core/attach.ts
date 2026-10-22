/**
 * Shared attach-source validation for `vibeflow tasks --attach`.
 *
 * The CLI handler and the unit tests both resolve through here, so the
 * refusal wording (missing path, directory, empty file, oversize, bad
 * name, executable type) is stated once. The size gate reuses
 * `MAX_FILE_SIZE` + `validateFilename` from `core/files.ts` — the same
 * limit the local file route (`express.raw({ limit: "50mb" })`), the MCP
 * `attach_file` tool, and the delta-push planner enforce — so every
 * surface refuses the same bytes with the same message.
 */
import { statSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { MAX_FILE_SIZE, validateFilename } from "./files.js";

export interface AttachSource {
  /** Absolute path of the source file on disk. */
  absPath: string;
  /** Bare filename that will be stored (`basename` — no directory part). */
  name: string;
  /** Byte size of the source file. */
  size: number;
  /** File bytes, read once the source passes every gate. */
  bytes: Buffer;
}

export interface AttachSourceRefusal {
  code: string;
  message: string;
  suggestion: string;
}

/**
 * Refusal for a second upload of the same (taskId, name) pair. The cloud
 * file route mints a fresh file id per POST (it never dedupes by name)
 * and the local store keeps one ref per name — so the CLI checks the
 * file list first and refuses the duplicate in BOTH modes instead of
 * letting one surface overwrite while the other duplicates.
 */
export function attachDuplicateRefusal(
  taskId: string,
  name: string,
): AttachSourceRefusal {
  return {
    code: "E_FILE_EXISTS",
    message: `File "${name}" is already attached to task ${taskId} — the same (task, name) pair is never uploaded twice`,
    suggestion:
      "Delete the existing file first, or attach under a different name.",
  };
}

/**
 * Resolve `rawPath` (relative to `cwd`) to validated attach bytes.
 * Pure filesystem read — never touches the task store.
 */
export function resolveAttachSource(
  cwd: string,
  rawPath: string,
):
  | { ok: true; source: AttachSource }
  | { ok: false; error: AttachSourceRefusal } {
  const absPath = resolve(cwd, rawPath);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absPath);
  } catch {
    return {
      ok: false,
      error: {
        code: "E_NOT_FOUND",
        message: `File not found: ${rawPath}`,
        suggestion: "Pass an existing file path to --attach.",
      },
    };
  }
  if (stat.isDirectory()) {
    return {
      ok: false,
      error: {
        code: "E_USAGE",
        message: `--attach needs a file, not a directory: ${rawPath}`,
        suggestion: "Pass a single file path to --attach.",
      },
    };
  }
  if (stat.size === 0) {
    return {
      ok: false,
      error: {
        code: "E_USAGE",
        message: `File is empty: ${rawPath} (nothing to attach)`,
        suggestion: "Attach a non-empty file — empty files are refused.",
      },
    };
  }
  const name = basename(absPath);
  const validation = validateFilename(name, stat.size);
  if (!validation.valid) {
    if (validation.errorCode === "VALIDATION") {
      return {
        ok: false,
        error: {
          code: "E_FILE_TOO_LARGE",
          message: `File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE} bytes)`,
          suggestion: `Shrink the file under ${MAX_FILE_SIZE} bytes, or attach a compressed archive (.zip) instead.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: validation.errorCode,
        message: validation.errorMessage,
        suggestion: validation.errorSuggestion,
      },
    };
  }
  return {
    ok: true,
    source: {
      absPath,
      name,
      size: stat.size,
      bytes: readFileSync(absPath),
    },
  };
}
