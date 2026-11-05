/**
 * Portable comment operation (ticket 3d613068).
 *
 * `add_comment`, migrated onto the async `TaskStore` ports: existence is
 * checked through the shared port-backed resolver, and the write is an
 * awaited port call. Wire behaviour is unchanged.
 */
import type { TaskComment } from "../types.js";
import type {
  OperationContext,
  OperationResult,
} from "../operations.js";
import { isDryRun } from "../operations.js";
import { resolveTaskOrRefusal } from "./resolution.js";
import { resolveWritePorts } from "../operation-context.js";
import { isRemoteReadError } from "../remote-task-store.js";
import {
  createHookScope,
  emitAfterHook,
  emitBeforeHook,
  beforeGateRefusal,
} from "../hooks/emit.js";
import { defaultToolForActivity } from "../hooks/tools.js";
import type { AddCommentInputType } from "@vibeflow-tools/api-core";

export async function addComment(
  ctx: OperationContext,
  input: AddCommentInputType,
): Promise<OperationResult<TaskComment>> {
  try {
    // P4 (ticket efcd6992): the WRITE runs against the write ports —
    // remote POST in saas mode, local files otherwise — so the MCP and
    // CLI comment share one authoritative path instead of the saas-mode
    // write minting a local ghost stub while the board saw no POST.
    const { store } = resolveWritePorts(ctx);
    // Existence check FIRST: a comment on a task that is not there used to
    // CREATE that task (title "Untitled", selector "/", status todo) and answer
    // ok:true — a ghost task on the board that no agent asked for and that the
    // CLI refuses to edit.
    const resolved = await resolveTaskOrRefusal(ctx, input.id);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (isDryRun(ctx, input)) {
      return {
        ok: true,
        data: {
          id: "dry-run",
          author: input.author,
          text: input.comment,
          createdAt: new Date().toISOString(),
        } as TaskComment,
        steps: [{ code: "DRY_RUN", message: "Comment would be added" }],
      };
    }
    // Pre-gate (Stage 2, ADR-0006): intended comment text, NOT a
    // generated commentId; task is the pre-write snapshot (immutable).
    // Deny/timeout/garbage/trust-fail BLOCKS (fail-closed).
    const commentGate = await emitBeforeHook(
      ctx,
      ctx.hookScope ?? createHookScope({ tool: defaultToolForActivity("task.comment"), surface: "cli" }),
      "task.comment",
      {
        payload: { taskId: resolved.id, text: input.comment },
        task: resolved.task,
        activityObject: { text: input.comment },
        bypass: ctx.hookBypass === true,
        command: "tasks --comment",
      },
    );
    if (!commentGate.allowed) {
      const refusal = beforeGateRefusal(commentGate);
      return {
        ok: false,
        error: {
          code: refusal.code,
          message: refusal.message,
          suggestion:
            "The pre-hook refused this comment — fix what the message names (or re-run with --no-verify to bypass loudly). Nothing was written.",
        },
      };
    }
    // The RESOLVED id, never input.id: prefix tolerance and the existence
    // check are decided once, in the resolver. AWAITED: the port settles
    // before the success is reported, so a delayed store cannot leave the
    // comment in flight while the tool answers ok:true.
    const comment = await store.addComment(
      ctx.projectDir,
      resolved.id,
      input.author,
      input.comment,
    );
    // After-hook (Stage 1, ADR-0006): this operation is user-invoked, so
    // every confirmed comment emits. System comments (verify notes,
    // bypass-audit, `cannot` reasons) are written via the store directly
    // and never pass through here — no hook cycle, by construction.
    // (input.author is typed `"user" | "agent"`: a `system` author
    // cannot arrive through this operation.)
    // Generic contract (ticket 431ee1c0): the AFTER envelope carries the
    // task snapshot as `task` and the written comment as `activityObject`
    // (the legacy payload is untouched). The comment write mints no
    // task-level fields, so the resolved snapshot stays accurate — the
    // new comment itself rides `activityObject`, not a re-read.
    const instructions = await emitAfterHook(
      ctx,
      ctx.hookScope ?? createHookScope({ tool: defaultToolForActivity("task.comment"), surface: "cli" }),
      "task.comment",
      { taskId: resolved.id, commentId: comment.id },
      undefined,
      { task: resolved.task, activityObject: comment },
    );
    const gateInstructions =
      commentGate.allowed && commentGate.instructions.length > 0
        ? commentGate.instructions
        : [];
    const merged = [...gateInstructions, ...instructions];
    return {
      ok: true,
      data: comment,
      ...(merged.length > 0 ? { instructions: merged } : {}),
    };
  } catch (err) {
    // A remote refusal travels VERBATIM (same rule as the task writes):
    // the code names the actual failure — never relabelled to a catch-all.
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
        code: "ADD_COMMENT_ERROR",
        message: err instanceof Error ? err.message : "Failed to add comment",
        suggestion:
          "Confirm the task exists (get_task) and the store is writable; the comment was NOT saved, so resend it",
      },
    };
  }
}
