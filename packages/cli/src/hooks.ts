/**
 * Public module-hook authoring types (ADR-0007).
 *
 * TYPE-ONLY boundary: this module has NO runtime exports — it re-exports
 * and narrows the internal envelope types for `.hook.mjs` / `.hook.ts`
 * authors. Never import it for values; the CLI executes hook modules in a
 * separate child process (the packaged `hook-loader.mjs`), never
 * in-process.
 *
 * Consumer (Node with type stripping — see `resolveTypeScriptHookSupport`
 * in `core/hooks/runner.ts` — with a local dev dependency on
 * `@vibeflow-tools/cli` for editor resolution even when the CLI itself is
 * installed globally):
 *
 * ```js
 * // @ts-check
 * /** @type {import('@vibeflow-tools/cli/hooks').HookAfterHandler<'task.update'>} *\/
 * export default async (envelope) => {
 *   return { instructions: `saw ${envelope.activity} (${envelope.payload.taskId})` };
 * };
 * ```
 *
 * TypeScript (erasable syntax only — type stripping, never compilation:
 * no JSX, no tsconfig paths, no enums; `import type` is erased and never
 * resolved):
 *
 * ```ts
 * import type { HookAfterHandler } from "@vibeflow-tools/cli/hooks";
 * const handler: HookAfterHandler<"task.update"> = async (envelope) => ({
 *   instructions: `saw ${envelope.activity} (${envelope.payload.taskId})`,
 * });
 * export default handler;
 * ```
 */
import type {
  HookActivity,
  HookConfirmedPayloads,
  HookIntentPayloads,
  HookSurface,
} from "./core/hooks/activities.js";
import type { HookEnvelope as CoreHookEnvelope } from "./core/hooks/envelope.js";

export type { HookActivity, HookConfirmedPayloads, HookIntentPayloads, HookSurface };

export type HookAfterPhase = "after";

export type HookBeforePhase = "before";

/**
 * Structural task view for hook authors (ADR-0007): the full task snapshot
 * is delivered as an immutable JSON copy, so authors get a structural
 * read view — never the store's `Task` type. Structural on purpose:
 * `@vibeflow-tools/api-core` (the canonical home of `TaskStatus` /
 * `TaskLinkType`) is private and bundled into the CLI, so the packed
 * `dist/hooks.d.ts` cannot import it (pinned by
 * `hooks-package.test.ts`: a tarball consumer has no api-core to
 * resolve). Payload shapes stay narrowed from core below — only the task
 * snapshot is a view, and it is documented here, not diverged silently.
 */
export interface HookTaskView {
  id?: string;
  title: string;
  description?: string;
  status?: string;
  type?: string;
  priority?: string;
  url?: string;
  selector?: string;
  author?: string;
  created?: string;
  [key: string]: unknown;
}

/**
 * Shared envelope shell (ADR-0007): the tool key + surface + the generic
 * contract (`task`, `activity`, `activityObject`, `instructions`) matching
 * the runtime envelope in `core/hooks/envelope.ts`. Structural — NOT
 * `Omit` of the core type — on purpose: the core `task` field is the
 * store's `Task`, whose `TaskStatus`/`TaskLinkType` live in
 * `@vibeflow-tools/api-core` (private, bundled, never published), so any
 * reference to the core envelope drags an unresolvable import into the
 * packed `dist/hooks.d.ts` (pinned by `hooks-package.test.ts`). Payloads
 * stay narrowed from core (`HookActivity`, `HookConfirmedPayloads`,
 * `HookIntentPayloads` are api-core-free); only the shell and the task
 * view are structural here. Drift between this shell and core is pinned
 * by the compile-time parity assertion below — update both sides together.
 */
export interface HookEnvelopeShell<A extends HookActivity | null, P> {
  schemaVersion: 2;
  tool: string;
  surface: HookSurface;
  activity: A;
  boardId: string | null;
  actor: string;
  ts: string;
  payload: P;
  task: HookTaskView | null;
  activityObject?: unknown;
  instructions: string;
}

type AfterPayload<A extends HookActivity | null> = A extends HookActivity
  ? HookConfirmedPayloads[A]
  : null;
type BeforePayload<A extends HookActivity | null> = A extends HookActivity
  ? HookIntentPayloads[A]
  : null;

/**
 * One after-phase envelope: the activity narrows the payload
 * (`activity: 'task.update'` narrows `payload` to `{taskId, changed}`).
 */
export type HookAfterEnvelope<A extends HookActivity | null = HookActivity | null> =
  HookEnvelopeShell<A, AfterPayload<A>> & {
    phase: HookAfterPhase;
  };

/**
 * The after-phase envelope union.
 */
export type HookEnvelope = {
  [A in HookActivity]: HookAfterEnvelope<A>;
}[HookActivity];

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
export type HookAfterHandler<A extends HookActivity | null = HookActivity | null> = (
  envelope: HookAfterEnvelope<A>,
) => HookAfterResult | Promise<HookAfterResult>;

/**
 * One before-phase envelope: the activity narrows the INTENT payload
 * (fields known before the write — never a generated id). Same generic
 * contract as after: the full task snapshot is immutable, and the ONLY
 * replaceable surface is `instructions`.
 */
export type HookBeforeEnvelope<A extends HookActivity | null = HookActivity | null> =
  HookEnvelopeShell<A, BeforePayload<A>> & {
    phase: HookBeforePhase;
  };

/** The before-phase envelope union. */
export type HookBeforeUnionEnvelope = {
  [A in HookActivity]: HookBeforeEnvelope<A>;
}[HookActivity];

/**
 * Exactly what the before-hook runner accepts: an explicit `{allow: true}`
 * (optional replacement `instructions`) or a denial
 * `{allow: false, reason}`. Anything else — empty stdout, non-JSON,
 * missing/non-boolean `allow`, missing/empty/non-string `reason` on deny,
 * extra keys — is `HOOK_BEFORE_MALFORMED` and BLOCKS the gated write
 * (fail-closed).
 */
export type HookBeforeResult =
  | { allow: true; instructions?: string }
  | { allow: false; reason: string; instructions?: string };

/**
 * A before-hook module: `export default` a (possibly async) function
 * receiving the full before envelope as its ONE argument and returning
 * the decision.
 *
 * ```js
 * // @ts-check
 * /** @type {import('@vibeflow-tools/cli/hooks').HookBeforeHandler<'task.create'>} *\/
 * export default async (envelope) => {
 *   if (envelope.payload.title.trim() === "")
 *     return { allow: false, reason: "title must not be empty" };
 *   return { allow: true };
 * };
 * ```
 */
export type HookBeforeHandler<A extends HookActivity | null = HookActivity | null> = (
  envelope: HookBeforeEnvelope<A>,
) => HookBeforeResult | Promise<HookBeforeResult>;

/**
 * Compile-time parity (ADR-0007, enforced by `tsc --noEmit`): the public
 * structural shell must expose every field the runtime envelope delivers.
 * If core gains a field, `_Missing` is non-never and this file fails to
 * compile — update `HookEnvelopeShell` (and the view) together with core.
 * Underscore-private on purpose: nothing here is exported, so the packed
 * `dist/hooks.d.ts` carries no reference to the core module (self-contained,
 * pinned by `hooks-package.test.ts`).
 */
type _CoreKeys = keyof CoreHookEnvelope<HookActivity | null>;
type _PublicKeys = keyof HookAfterEnvelope<HookActivity | null>;
type _Missing = Exclude<_CoreKeys, _PublicKeys>;
const _assertNoMissing: _Missing extends never ? true : never = true;
