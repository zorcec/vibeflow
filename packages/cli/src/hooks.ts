/**
 * Public module-hook authoring types (ADR-0006 Stage 1.5).
 *
 * TYPE-ONLY boundary: this module has NO runtime exports — it re-exports
 * and narrows the internal envelope types for `.hook.mjs` authors. Never
 * import it for values; the CLI executes hook modules in a separate child
 * process (the packaged `hook-loader.mjs`), never in-process.
 *
 * Consumer (Node >= 22, with a local dev dependency on
 * `@vibeflow-tools/cli` for editor resolution even when the CLI itself is
 * installed globally):
 *
 * ```js
 * // @ts-check
 * /** @type {import('@vibeflow-tools/cli/hooks').HookAfterHandler<'task.update'>} *\/
 * export default async (envelope) => {
 *   return { instructions: `saw ${envelope.event} (${envelope.payload.taskId})` };
 * };
 * ```
 */
import type {
  HookAfterPayloads,
  HookEnvelope as CoreHookEnvelope,
  HookEvent,
} from "./core/hooks/envelope.js";

export type { HookAfterPayloads, HookEvent };

/** Phase is always `after` today — Stage 2 adds real pre-intent payloads. */
export type HookAfterPhase = "after";

/**
 * One after-phase envelope: the event narrows the payload
 * (`event: 'task.update'` narrows `payload` to `{taskId, changed}`).
 *
 * Built from the internal runtime envelope type (single source of truth),
 * narrowed from `phase: HookPhase` to the after-only phase — never a
 * divergent manual copy, and never published as a pre-hook contract.
 */
export type HookAfterEnvelope<E extends HookEvent = HookEvent> = Omit<
  CoreHookEnvelope<E>,
  "phase"
> & {
  phase: HookAfterPhase;
};

/**
 * The active hook envelope today: the after-only union. Do NOT mistake the
 * internal generic for a pre-hook contract — pre payloads do not exist yet
 * (Stage 2 defines them).
 */
export type HookEnvelope = {
  [E in HookEvent]: HookAfterEnvelope<E>;
}[HookEvent];

/**
 * Exactly what the runner accepts: `{instructions: string}` or the `{}`
 * no-op. Extra keys are REJECTED at runtime (`HOOK_BAD_OUTPUT`), so this
 * type has no index signature — `{instructions: 42}` and `{extra: 1}` are
 * compile errors here, not silent coercions.
 */
export type HookAfterResult =
  | { instructions: string }
  | { instructions?: never };

/**
 * A module hook: `export default` a (possibly async) function receiving
 * the full envelope as its ONE argument and returning the result.
 */
export type HookAfterHandler<E extends HookEvent = HookEvent> = (
  envelope: HookAfterEnvelope<E>,
) => HookAfterResult | Promise<HookAfterResult>;
