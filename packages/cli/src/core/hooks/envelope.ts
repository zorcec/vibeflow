/**
 * Agent-hooks envelope v2 — the ONE builder (ADR-0007).
 *
 * Vocabulary is unified on before/after — one spelling per concept:
 * filename suffix, envelope `phase`, failure-policy names, error codes,
 * type names. The v1 "pre" vocabulary is deleted outright (unreleased ⇒
 * no aliases, no dual-read, no deprecation notices).
 *
 * GENERIC CONTRACT (owner decision, kept from Stage 2): every hook
 * (before/after, all 8 activities) receives exactly one JSON document
 * on stdin with the SAME shape: the tool key + surface + the full task
 * object (immutable snapshot) + the explicit activity enum + the activity
 * object when one exists + the current agent-instruction draft (the ONLY
 * thing a hook may replace — tasks are read-only).
 * Before-phase carries INTENT (fields known before the write; no generated
 * ids); after-phase carries the CONFIRMED record. Null task only where no
 * single task exists (push/pull/verify run intents, and null-activity
 * invocations such as reads, `kanban`/`serve`, `auth`).
 *
 * The legacy activity `payload` is kept byte-identical so shipped
 * after-hooks and defaults keep working; new code should read the generic
 * fields. Call sites pass `tool` + `surface` + `activity` + `payload` (+
 * generic extras) only — the envelope is never re-assembled elsewhere
 * (pinned by `envelope.test.ts`: no other module may build one).
 *
 * `boardId` is `null` locally: a local board has no server-side identity,
 * and naming a workspace pointer here would leak project layout into
 * hook input. `schemaVersion` is a literal in this file only — it versions
 * the ENVELOPE contract, not the package (see ADR-0007).
 */

import type { Task } from "../types.js";
import type {
  HookActivity,
  HookConfirmedPayloads,
  HookIntentPayloads,
  HookSurface,
} from "./activities.js";

// Re-exported so existing importers keep one path (`./envelope.js`); the
// api-core-free leaf is `./activities.js` — the public authoring boundary
// (`src/hooks.ts`) imports from THERE, never from this Task-carrying
// module, so the packed `dist/hooks.d.ts` stays self-contained (pinned by
// `hooks-package.test.ts`: a tarball consumer has no api-core).
export type { HookActivity, HookConfirmedPayloads, HookIntentPayloads, HookSurface };

export const HOOK_SCHEMA_VERSION = 2;

export type HookPhase = "before" | "after";

/**
 * Full task for the generic contract: the CONFIRMED record (after) or the
 * best-known INTENT (before — fields known before the write; never a
 * generated id). Hooks receive it as an immutable JSON snapshot and MUST
 * NOT treat it as writable: the ONLY mutable surface is `instructions`.
 */
export type HookTaskSnapshot = Task | (Partial<Task> & { title: string }) | null;

export interface HookEnvelope<A extends HookActivity | null = HookActivity | null> {
  schemaVersion: typeof HOOK_SCHEMA_VERSION;
  /** The canonical hook key (never an alias) — the filename without the phase suffix. */
  tool: string;
  /** Which surface ran the tool: `"cli"` | `"mcp"`. */
  surface: HookSurface;
  phase: HookPhase;
  /** Null locally — a local board has no server-side identity. */
  boardId: string | null;
  actor: string;
  ts: string;
  /**
   * Explicit activity enum: the unit of work, or `null` when the
   * invocation had no durable effect (read / `kanban` / `serve` / `auth`).
   * Redundant on purpose — generic consumers read ONE field.
   */
  activity: A;
  /** Activity payload, byte-identical (intent before, confirmed after); null iff activity is null. */
  payload: A extends HookActivity ? HookConfirmedPayloads[A] | HookIntentPayloads[A] : null;
  /**
   * GENERIC CONTRACT (owner): the full task — snapshot after the write,
   * intent before it — or null where no single task exists (push/pull/
   * verify run intents; null-activity invocations carry the read/target
   * record when one exists). Immutable by contract.
   */
  task: HookTaskSnapshot;
  /**
   * The secondary record the activity acted on/with, when one exists
   * (comment text, changed-keys, claim filters, …). Immutable snapshot.
   */
  activityObject?: unknown;
  /**
   * Current agent-instruction draft: the ONLY replaceable surface.
   * Empty pre-write; a hook replaces it by returning
   * `{instructions: "..."}` (after) or `{allow, instructions?}` (before).
   */
  instructions: string;
}

export interface HookEnvelopeInput<A extends HookActivity | null> {
  tool: string;
  surface: HookSurface;
  phase: HookPhase;
  boardId: string | null;
  actor: string;
  activity: A;
  /** Wide at the boundary — narrowed to the conditional by the builder (single cast, contained there). */
  payload: HookConfirmedPayloads[HookActivity] | HookIntentPayloads[HookActivity] | null;
  task?: HookTaskSnapshot;
  activityObject?: unknown;
  instructions?: string;
}

/** The ONE envelope builder. All emit sites call this — nothing else. */
export function buildHookEnvelope<A extends HookActivity | null>(
  input: HookEnvelopeInput<A>,
): HookEnvelope<A> {
  return {
    schemaVersion: HOOK_SCHEMA_VERSION,
    tool: input.tool,
    surface: input.surface,
    phase: input.phase,
    boardId: input.boardId,
    actor: input.actor,
    ts: new Date().toISOString(),
    activity: input.activity,
    payload: input.payload as HookEnvelope<A>["payload"],
    task: input.task ?? null,
    ...(input.activityObject !== undefined
      ? { activityObject: input.activityObject }
      : {}),
    instructions: input.instructions ?? "",
  };
}
