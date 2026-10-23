/**
 * Portable file operations (ticket 3d613068).
 *
 * `attach_file`, migrated onto the async `TaskStore` ports, plus the
 * omission-count helper the read surfaces (`list_tasks`, `get_task`) use to
 * pin `commentCount`/`fileCount` onto projected rows. Wire behaviour is
 * unchanged.
 *
 * P5 (ticket 4a5f7df6): the standalone `tasks --attach` mode routes through
 * `attachStandalone` below — the same duplicate/size/name policy, with the
 * surface's own inputs made explicit: a typed source (MCP bytes vs a CLI
 * path on disk), an explicit `onExisting` duplicate policy (the CLI refuses
 * the pair, MCP replaces in place), and `moveAfterSuccess` (the CLI's
 * `--move` source consumption). `attachFile` stays the MCP spelling: bytes
 * + replace, returning the bare FileInfo wire shape.
 */
import { basename } from "node:path";
import { unlinkSync } from "node:fs";
import type { FileInfo } from "../files.js";
import type {
  OperationContext,
  OperationResult,
} from "../operations.js";
import { isDryRun } from "../operations.js";
import { resolveTaskOrRefusal } from "./resolution.js";
import { resolveOperationPorts } from "../task-store.js";
import { resolveReadPorts } from "../operation-context.js";
import { attachDuplicateRefusal } from "../attach.js";
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
  // P2 CLI-through-operations slice (ticket d7b9dc13): the counts come
  // from the READ ports for this mode, not the local write-path ports.
  // Under mode saas the old resolution read the LOCAL sidecars, so a
  // remote projection carried local counts — the same phantom-record class
  // (stale local data presented as current) this ticket exists to kill.
  // Under mode local both resolutions answer the same adapter: unchanged.
  const { store } = resolveReadPorts(ctx);
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

/**
 * Where the attach bytes come from. MCP clients send bytes (they may not
 * share the filesystem); the CLI names a path on disk, resolved against a
 * cwd exactly like `--report-file` (the `[dir]` positional is the project
 * root, never the source). One input, two spellings — never a mixed form.
 */
export type AttachSourceInput =
  | { kind: "bytes"; filename: string; content: Uint8Array }
  | { kind: "localPath"; path: string; cwd: string };

/**
 * CLI-only internal attach input (ticket 4a5f7df6, P5). NOT part of the MCP
 * schema: MCP sends bytes + replace through `attachFile` below, while the
 * CLI translates `--attach <path> --task <id> [--move]` into this AFTER no
 * filesystem read of its own — the path is resolved (missing / directory /
 * empty / name / size gates) inside the operation, so both surfaces share
 * one gate order and one refusal wording.
 */
export interface AttachStandaloneInput {
  /** Full id or unique prefix — resolved through the one shared rule. */
  id: string;
  source: AttachSourceInput;
  /**
   * `refuse`: a second upload of the same (task, name) pair is E_FILE_EXISTS
   * (the CLI promise — the pair is never uploaded twice). `replace`: the
   * bytes overwrite in place, one ref per name (the MCP promise).
   */
  onExisting: "refuse" | "replace";
  /**
   * The CLI's `--move`: delete the `localPath` source after the attach is
   * confirmed. A failed delete is a MOVE_CLEANUP_FAILED notice on a
   * successful attach — never a whole-operation failure (the task data
   * landed; retrying the attach would be wrong). Meaningless for `bytes`.
   */
  moveAfterSuccess?: boolean;
  dryRun?: boolean;
}

export interface AttachStandaloneData extends FileInfo {
  /** The resolved full task id the file landed on. */
  taskId: string;
  /** The online file id, when the board minted one. */
  fileId?: string;
  /** True when `replace` overwrote an existing attachment. */
  replaced?: boolean;
}

/**
 * The shared standalone-attachment operation (ticket 4a5f7df6, P5).
 *
 * Gate order (identical on both backends): existence → source → duplicate /
 * size / name policy → dry-run preview → exactly ONE upload → optional
 * source consumption. The source is retained on every refusal, on preview,
 * and on upload failure; it is consumed only after a confirmed attach.
 *
 * Backend rule (P2 frozen scope): `saas` without an injected store talks to
 * the board it resolved against — duplicate names are read from the task's
 * remote file list and bytes go up through the file route (one POST, never
 * retried). The board mints a fresh file id per POST, so `replace` over an
 * existing remote name is REFUSED rather than falsely succeeded — there is
 * no backend replace, and a second POST would duplicate, not replace.
 */
export async function attachStandalone(
  ctx: OperationContext,
  input: AttachStandaloneInput,
): Promise<OperationResult<AttachStandaloneData>> {
  try {
    // Existence check FIRST, against the authoritative store for this mode.
    // Without it an unknown id still wrote a file for a task that does not
    // exist (the ghost-file class P1 removed).
    const resolved = await resolveTaskOrRefusal(ctx, input.id);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    // Source bytes: read-only, never a store access. The path resolves
    // against the caller's cwd (like --report-file); the [dir] positional
    // stays the project root.
      let filename: string;
      let bytes: Buffer;
      let sourceAbsPath: string | undefined;
      // Every attach gate resolves through the shared attach module
      // (core/attach.ts) — never a storage import, per the check-5 boundary.
      const { resolveAttachSource, refuseRawAttachFilename } = await import(
        "../attach.js"
      );
      if (input.source.kind === "bytes") {
        // Validate the RAW name first (WP-1): separators, traversal and
        // control bytes are refusals, never silently sanitised — the client
        // asked for `../escape.md` and must not get `escape.md` by
        // surprise. Storage below still basenames (saveFile's own rule).
        const rawName = input.source.filename;
        const rawRefusal = refuseRawAttachFilename(
          rawName,
          input.source.content.length,
        );
        if (rawRefusal) return { ok: false, error: rawRefusal };
        filename = basename(rawName);
        bytes = Buffer.from(input.source.content);
      } else {
        const validated = resolveAttachSource(
          input.source.cwd,
          input.source.path,
        );
        if (!validated.ok) return { ok: false, error: validated.error };
        filename = validated.source.name;
        bytes = validated.source.bytes;
        sourceAbsPath = validated.source.absPath;
      }

    // Size/name policy BEFORE the duplicate check and before any upload.
    // Local (or injected) stores enforce through their own adapter verdict;
    // the remote path has no adapter verdict (validateAttachment is a
    // write-routed port) so it applies the same shared rule directly.
    const remote = ctx.mode === "saas" && !ctx.store;
    if (remote) {
      const rawRefusal = refuseRawAttachFilename(filename, bytes.length);
      if (rawRefusal) return { ok: false, error: rawRefusal };
    } else if (input.source.kind === "bytes") {
      const verdict = await resolveOperationPorts(ctx).store.validateAttachment(
        ctx.projectDir,
        filename,
        bytes.length,
      );
      if (!verdict.valid) {
        return {
          ok: false,
          error: {
            code: verdict.errorCode,
            message: verdict.errorMessage,
            suggestion: verdict.errorSuggestion,
          },
        };
      }
    }

    // Duplicate policy: the same (task, name) pair is never uploaded twice
    // under `refuse`. The names come from the authoritative store — the
    // remote detail's file list in saas mode — so both modes refuse the same
    // pair (the cloud route would otherwise mint a second file id for one
    // name, while the local store keeps one ref per name).
    const { store: readStore } = resolveReadPorts(ctx);
    const existing = await readStore.listFiles(ctx.projectDir, resolved.id);
    const duplicate = existing.some((f) => f.name === filename);
    if (duplicate && input.onExisting === "refuse") {
      const refusal = attachDuplicateRefusal(resolved.id, filename);
      return { ok: false, error: refusal };
    }
    if (duplicate && remote) {
      // No backend replace: a second POST would mint a second file id for
      // one name, reporting success while duplicating. Refuse loudly with
      // the recovery (a new name uploads fine) instead.
      return {
        ok: false,
        error: {
          code: "E_FILE_EXISTS",
          message: `File "${filename}" is already attached to task ${resolved.id} — the online board cannot replace it in place`,
          suggestion:
            "Attach under a different name. The online file API mints a new file per upload and has no replace or delete.",
        },
      };
    }

    if (isDryRun(ctx, input)) {
      return {
        ok: true,
        data: {
          name: filename,
          size: bytes.length,
          url: `/api/tasks/${resolved.id}/files/${encodeURIComponent(filename)}`,
          taskId: resolved.id,
          ...(duplicate ? { replaced: true } : {}),
        },
        steps: [{ code: "DRY_RUN", message: "File would be attached" }],
      };
    }

    let info: FileInfo;
    let fileId: string | undefined;
    if (remote) {
      // Exactly ONE upload, awaited, never retried — the report-attach
      // path (operations/tasks.ts) POSTs the same route the same way.
      const { uploadSaasFile } = await import("../../saas/client.js");
      const { toRemoteWriteRefusal } = await import(
        "../remote-task-store.js"
      );
      const uploaded = await uploadSaasFile(resolved.id, filename, bytes);
      if (!uploaded.ok) {
        throw toRemoteWriteRefusal(
          uploaded.error,
          "The file was NOT attached — fix what the message names and resend.",
        );
      }
      info = {
        name: uploaded.data.name,
        size: uploaded.data.size,
        url:
          uploaded.data.url ??
          `/api/tasks/${resolved.id}/files/${encodeURIComponent(uploaded.data.name)}`,
      };
      fileId = uploaded.data.id;
    } else {
      const { store } = resolveOperationPorts(ctx);
      info = await store.saveFile(ctx.projectDir, resolved.id, filename, bytes);
    }

    // Source consumption: only for a `localPath` source, only after the
    // attach above is confirmed. A vanishing source here is a TOCTOU corner,
    // not a failed attach — the bytes landed, so it rides a notice while ok
    // stays true (retrying the attach would be wrong).
    const steps: Array<{ code: string; message: string }> = [];
    if (input.moveAfterSuccess && sourceAbsPath !== undefined) {
      try {
        unlinkSync(sourceAbsPath);
      } catch (err) {
        steps.push({
          code: "MOVE_CLEANUP_FAILED",
          message: `File WAS attached, but the source file could not be deleted: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return {
      ok: true,
      data: {
        ...info,
        taskId: resolved.id,
        ...(fileId !== undefined ? { fileId } : {}),
        ...(duplicate ? { replaced: true } : {}),
      },
      ...(steps.length > 0 ? { steps } : {}),
    };
  } catch (err) {
    const { isRemoteReadError } = await import("../remote-task-store.js");
    if (isRemoteReadError(err)) {
      return {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.suggestion ? { suggestion: err.suggestion } : {}),
          ...(err.retryable !== undefined ? { retryable: err.retryable } : {}),
        },
      };
    }
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

/**
 * The MCP `attach_file` spelling: caller bytes + replace. Local behaviour is
 * byte-identical to before (replace in place, one ref per name); in saas
 * mode the bytes now POST to the board the existence check resolved against
 * instead of minting a local ghost file (the authoritative-write flip P4
 * made for create/update/comment, documented the same way — see the
 * pin-suite note in tests/unit/operations-p5-characterization.test.ts).
 */
export async function attachFile(
  ctx: OperationContext,
  input: AttachFileInputType,
): Promise<OperationResult<FileInfo>> {
  const r = await attachStandalone(ctx, {
    id: input.id,
    source: {
      kind: "bytes",
      filename: input.filename,
      content: Buffer.from(input.contentB64, "base64"),
    },
    onExisting: "replace",
    dryRun: input.dryRun,
  });
  if (!r.ok) return r;
  // The MCP wire shape is unchanged: bare FileInfo. The extended fields
  // (taskId/fileId/replaced) stay inside the operation for the CLI renderer.
  const { taskId: _taskId, fileId: _fileId, replaced: _replaced, ...file } = r.data ?? {};
  void _taskId;
  void _fileId;
  void _replaced;
  return { ok: true, data: file as FileInfo, ...(r.steps ? { steps: r.steps } : {}) };
}
