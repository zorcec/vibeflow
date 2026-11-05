/**
 * Agent-hooks envelope — the ONE builder (ADR-0006).
 *
 * Every hook (pre/after, all 8 events) receives exactly one JSON document
 * on stdin: 6 shared fields + an event/phase-typed payload. Call sites pass
 * `event` + `payload` only — the envelope is never re-assembled elsewhere
 * (pinned by `envelope.test.ts`: no other module may build one).
 *
 * `boardId` is `null` locally: a local board has no server-side identity to
 * name, and naming a workspace pointer here would leak project layout into
 * hook input. `schemaVersion` is a literal in this file only — it versions
 * the ENVELOPE contract, not the package (see ADR-0006).
 */

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

export interface HookEnvelope<E extends HookEvent = HookEvent> {
  schemaVersion: typeof HOOK_SCHEMA_VERSION;
  event: E;
  phase: HookPhase;
  /** Null locally — a local board has no server-side identity (ADR-0006). */
  boardId: string | null;
  actor: string;
  ts: string;
  payload: HookAfterPayloads[E];
}

export interface HookEnvelopeInput<E extends HookEvent> {
  event: E;
  phase: HookPhase;
  boardId: string | null;
  actor: string;
  payload: HookAfterPayloads[E];
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
  };
}
