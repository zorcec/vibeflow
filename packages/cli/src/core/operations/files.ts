/**
 * Portable file operations (ticket 3d613068).
 *
 * `attach_file`, migrated onto the async `TaskStore` ports, plus the
 * omission-count helper the read surfaces (`list_tasks`, `get_task`) use to
 * pin `commentCount`/`fileCount` onto projected rows. Wire behaviour is
 * unchanged.
 */
import { basename } from "node:path";
import type { FileInfo } from "../files.js";
import type {
  OperationContext,
  OperationResult,
} from "../operations.js";
import { isDryRun } from "../operations.js";
import { resolveTaskOrRefusal } from "./resolution.js";
import { resolveOperationPorts } from "../task-store.js";
import type { AttachFileInputType } from "@vibeflow-tools/api-core";

/**
 * WHAT/WHY (ticket b2e56212, change 3): a `fields` projection used to omit
 * `comments` (and `files`) with NO signal they exist — an owner ticket was
 * read without comments, the owner's own bug report on it went unseen, and
 * a live functional regression was mis-diagnosed as visual taste. So every
 * projected row carries the cheap counts of what it omitted:
 * `commentCount` / `fileCount`, read from the SAME sidecar readers the
 * human listing renders (listComments excludes deleted, like the display).
 * Attached ALWAYS on a projected response — even when `fields` names the
 * arrays (counts are cheap and unambiguous) — and never on a full response
 * (the arrays themselves are the signal there). A sidecar read that throws
 * falls back to the embedded array length, never to a failed listing.
 * SCOPE: the read surfaces (list_tasks/get_task + CLI --json). The write
 * surfaces (create/update `fields`) return the just-written object and are
 * deliberately untouched — their own ticket if that ever misleads.
 */
export async function attachOmissionCounts(
  ctx: OperationContext,
  row: Record<string, unknown>,
  taskId: string,
): Promise<Record<string, unknown>> {
  const { store } = resolveOperationPorts(ctx);
  let commentCount: number;
  let fileCount: number;
  try {
    commentCount = (await store.listComments(ctx.projectDir, taskId)).length;
  } catch {
    const embedded = (row as { comments?: unknown }).comments;
    commentCount = Array.isArray(embedded) ? embedded.length : 0;
  }
  try {
    fileCount = (await store.listFiles(ctx.projectDir, taskId)).length;
  } catch {
    const embedded = (row as { files?: unknown }).files;
    fileCount = Array.isArray(embedded) ? embedded.length : 0;
  }
  return { ...row, commentCount, fileCount };
}

export async function attachFile(
  ctx: OperationContext,
  input: AttachFileInputType,
): Promise<OperationResult<FileInfo>> {
  try {
    const { store } = resolveOperationPorts(ctx);
    // Existence check FIRST. Without it an unknown id still wrote
    // `.vibeflow/tasks/files/<id>/<name>` and answered ok:true with a URL for
    // a file belonging to a task that does not exist.
    const resolved = await resolveTaskOrRefusal(ctx, input.id);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const buffer = Buffer.from(input.contentB64, "base64");
    // Gate BEFORE saveFile — reject manifest files, invalid extensions,
    // oversized uploads. Policy lives in the adapter (local rule wraps
    // core/files.ts); the operation only enforces the verdict.
    const validation = await store.validateAttachment(
      ctx.projectDir,
      input.filename,
      buffer.length,
    );
    if (!validation.valid) {
      return {
        ok: false,
        error: {
          code: validation.errorCode,
          message: validation.errorMessage,
          suggestion: validation.errorSuggestion,
        },
      };
    }
    if (isDryRun(ctx, input)) {
      return {
        ok: true,
        data: {
          name: basename(input.filename),
          size: buffer.length,
          url: `/api/tasks/${resolved.id}/files/${encodeURIComponent(basename(input.filename))}`,
        } as FileInfo,
        steps: [{ code: "DRY_RUN", message: "File would be attached" }],
      };
    }

    const info = await store.saveFile(
      ctx.projectDir,
      resolved.id,
      input.filename,
      buffer,
    );
    return { ok: true, data: info };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "ATTACH_FILE_ERROR",
        message: err instanceof Error ? err.message : "Failed to attach file",
        suggestion:
          "The file was NOT written — confirm the task exists (get_task), the filename is not an executable type (.exe/.dll/.ps1 and siblings are refused; zip it first), and the payload is under the size limit, then resend",
      },
    };
  }
}
