/**
 * Agent-hooks envelope — the ONE builder (ADR-0006).
 *
 * GENERIC CONTRACT (owner decision, Stage 2 ticket wla7ci2wzbgaj5dqsrvh1j4o):
 * every hook (pre/after, all 8 events) receives exactly one JSON document
 * on stdin with the SAME shape: 6 shared fields + the full task object
 * (immutable snapshot) + the explicit activity enum + the activity object
 * when one exists (comment/label/...) + the current agent-instruction draft
 * (the ONLY thing a hook may replace — tasks are read-only).
 * Pre-phase carries INTENT (fields known before the write; no generated
 * ids); after-phase carries the CONFIRMED record. Null task only where no
 * single task exists (push/pull/verify run intents).
 *
 * The legacy event `payload` is kept byte-identical so shipped after-hooks
 * and defaults keep working; new code should read the generic fields.
 * Call sites pass `event` + `payload` (+ generic extras) only — the envelope
 * is never re-assembled elsewhere (pinned by `envelope.test.ts`: no other
 * module may build one).
 *
 * `boardId` is `null` locally: a local board has no server-side identity to
 * name, and naming a workspace pointer here would leak project layout into
 * hook input. `schemaVersion` is a literal in this file only — it versions
 * the ENVELOPE contract, not the package (see ADR-0006).
 */

import type { Task } from "../types.js";

export const HOOK_SCHEMA_VERSION = 1;

export type HookPhase = "pre" | "after";

/**
 * The deliberately-8 event set. No `task.list`, no files/links/boards/mcp —
 * an event exists only when something must be gated or narrated (ADR-0006).
 */
export type HookEvent =
  | "task.create"
  | "task.update"
  | "task.claim"
  | "task.delete"
  | "task.comment"
  | "push"
  | "pull"
  | "verify";

/**
 * After-phase payloads describe the CONFIRMED durable effect (post-write
 * result). Stage 2 adds the pre-phase intent payloads; the phase split is
 * load-bearing (Sol review P1-1: claim is atomic, commentId/verify results
 * exist only post-write), so pre and after payloads are distinct types, not
 * one shared shape.
 */
export interface HookAfterPayloads {
  "task.create": {
    task: { id: string; title: string; status: string; type?: string };
  };
  "task.update": { taskId: string; changed: string[] };
  "task.claim": { taskId: string; from: string; to: string };
  "task.delete": { taskId: string; childCount: number };
  "task.comment": { taskId: string; commentId: string };
  push: { taskCount: number; chunkCount: number; transport: string };
  pull: { written: number; skipped: number; mode: string };
  verify: { taskId: string; verdict: string };
}

/**
 * Pre-phase INTENT payloads: what the invocation intends, BEFORE any
 * durable effect (Stage 2). No generated ids (no task id on create, no
 * commentId, no verdict) — a pre-hook that needs the result must allow
 * and read the after-hook. Claim pre-gate is invocation-level over the
 * claim FILTERS (atomic claim preserved — no preview-then-update, no
 * reservation protocol). Same deliberately-8 event set; distinct from
 * after payloads on purpose (Sol review P1-1).
 */
export interface HookPrePayloads {
  "task.create": {
    title: string;
    description?: string;
    status?: string;
    type?: string;
    priority?: string;
    tags?: string[];
  };
  "task.update": { taskId: string; changed: string[] };
  "task.claim": { type?: string; user?: string; tag?: unknown };
  "task.delete": { taskId: string; childCount: number };
  "task.comment": { taskId: string; text: string };
  push: { dryRun?: boolean };
  pull: { mode?: string };
  verify: { taskId: string };
}

/**
 * Full task for the generic contract: the CONFIRMED record (after) or the
 * best-known INTENT (pre — fields known before the write; never a
 * generated id). Hooks receive it as an immutable JSON snapshot and MUST
 * NOT treat it as writable: the ONLY mutable surface is `instructions`.
 */
export type HookTaskSnapshot = Task | (Partial<Task> & { title: string }) | null;

export interface HookEnvelope<E extends HookEvent = HookEvent> {
  schemaVersion: typeof HOOK_SCHEMA_VERSION;
  event: E;
  phase: HookPhase;
  /** Null locally — a local board has no server-side identity (ADR-0006). */
  boardId: string | null;
  actor: string;
  ts: string;
  /** Legacy event payload, byte-identical (after = confirmed, pre = intent). */
  payload: HookAfterPayloads[E] | HookPrePayloads[E];
  /**
   * GENERIC CONTRACT (owner, Stage 2): the full task — snapshot after the
   * write, intent before it — or null where no single task exists
   * (push/pull/verify run intents). Immutable by contract: hooks get a
   * JSON copy and cannot alter the store through it.
   */
  task: HookTaskSnapshot;
  /**
   * Explicit activity enum (owner, Stage 2): always equals `event`.
   * Redundant on purpose — generic consumers read ONE field.
   */
  activity: E;
  /**
   * The secondary record the activity acted on/with, when one exists
   * (comment text, changed-keys, claim filters, …). Immutable snapshot.
   */
  activityObject?: unknown;
  /**
   * Current agent-instruction draft (owner, Stage 2): the ONLY replaceable
   * surface. Empty pre-write; a hook replaces it by returning
   * `{instructions: "..."}` (after) or `{allow, instructions?}` (pre).
   */
  instructions: string;
}

export interface HookEnvelopeInput<E extends HookEvent> {
  event: E;
  phase: HookPhase;
  boardId: string | null;
  actor: string;
  payload: HookAfterPayloads[E] | HookPrePayloads[E];
  task?: HookTaskSnapshot;
  activityObject?: unknown;
  instructions?: string;
}

/** The ONE envelope builder. All 8 emit sites call this — nothing else. */
export function buildHookEnvelope<E extends HookEvent>(
  input: HookEnvelopeInput<E>,
): HookEnvelope<E> {
  return {
    schemaVersion: HOOK_SCHEMA_VERSION,
    event: input.event,
    phase: input.phase,
    boardId: input.boardId,
    actor: input.actor,
    ts: new Date().toISOString(),
    payload: input.payload,
    task: input.task ?? null,
    activity: input.event,
    ...(input.activityObject !== undefined
      ? { activityObject: input.activityObject }
      : {}),
    instructions: input.instructions ?? "",
  };
}
