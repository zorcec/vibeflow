/**
 * Needs-attention claim notification (owner round 2).
 *
 * When a task is moved into progress on a task the flag predates — claim
 * via `tasks --next` / `--edit --set-status in-progress`, local MCP
 * `update_task` / `claim_next_task` (the hosted path resolves through the
 * same shared operations, so it is covered by the same call sites) — the
 * result MUST surface the flag plus the reason comment to the agent, or
 * the agent starts work blind to what the flagger needed.
 *
 * The reason is a proxy: setting the flag REQUIRES a same-call `--comment`
 * (CLI) / `comment` (MCP), so the latest non-deleted, non-system comment is
 * the reason in the common case. System comments (verify notes, file
 * traces) never carry it, deleted rows are history — both are skipped. When
 * no comment survives the filter (e.g. a remote PATCH row without embedded
 * comments), the notice says so and points at the feed instead of
 * inventing a reason.
 *
 * Shape: one NEEDS_ATTENTION notice (steps/notices payload) plus exactly
 * ONE dynamic instruction line riding the result's instructions (the
 * after-hook instruction text the agent reads). The shipped hook defaults
 * stay untouched (ADR-0007; hook texts were compressed under hm3sxd140) —
 * this line is operation-owned and conditional, so the static counts do
 * not move.
 */
import type { Task, TaskComment } from "./types.js";

/** Notice code agents branch on (steps internally, `notices` on the wire). */
export const ATTENTION_NOTICE_CODE = "NEEDS_ATTENTION";

/**
 * One-line budget for the notification (reason excerpt). The instruction
 * must stay a single short line — it rides the compressed hook texts.
 */
export const ATTENTION_REASON_MAX = 160;

export interface AttentionAlert {
  /** Steps/notices entry — the flag + reason in the output payload. */
  notice: { code: string; message: string };
  /** The single dynamic instruction line for the result's instructions. */
  instruction: string;
}

type CommentLike = Pick<TaskComment, "text" | "createdAt"> &
  Partial<Pick<TaskComment, "type" | "deleted">>;

function isReasonCandidate(c: CommentLike): boolean {
  if (c.deleted === true) return false;
  if ((c.type ?? "comment") !== "comment") return false;
  return typeof c.text === "string" && c.text.trim().length > 0;
}

/**
 * Latest surviving comment text, whitespace-collapsed and truncated to
 * one line — or null when nothing qualifies (caller falls back to the
 * flag-only wording, never an invented reason).
 */
export function attentionReasonText(
  comments: readonly CommentLike[] | undefined | null,
): string | null {
  if (!Array.isArray(comments) || comments.length === 0) return null;
  const latest = [...comments]
    .filter(isReasonCandidate)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .at(-1);
  if (!latest) return null;
  const oneLine = latest.text.trim().replace(/\s+/g, " ");
  if (oneLine.length <= ATTENTION_REASON_MAX) return oneLine;
  return `${oneLine.slice(0, ATTENTION_REASON_MAX - 1).trimEnd()}…`;
}

/**
 * The claim notification for a freshly-claimed (in-progress) task, or null
 * when the task carries no flag. `taskId` feeds the `--get` pointer; pure
 * (no store reads) so every claim path — CLI local/saas, MCP, operations —
 * shares one wording.
 */
export function attentionClaimAlert(
  task: Pick<Task, "needsAttention" | "comments"> | null | undefined,
  taskId: string,
): AttentionAlert | null {
  if (!task || task.needsAttention !== true) return null;
  const reason = attentionReasonText(task.comments);
  const detail =
    reason !== null
      ? reason
      : "Flag is set with no reason comment — read the activity feed.";
  return {
    notice: {
      code: ATTENTION_NOTICE_CODE,
      message: `Needs attention: ${detail}`,
    },
    instruction: `Needs attention: ${detail} Read the full thread before implementing (vibeflow tasks --get ${taskId}).`,
  };
}
