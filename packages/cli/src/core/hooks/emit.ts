/**
 * Shared after-hook dispatch helper — the ONE path every emit site uses
 * (ADR-0006).
 *
 * The 8 events are OPERATION-OWNED (not TaskStore-emitted): `push`/`pull`/
 * `verify` are not store methods, online delete never calls a store delete,
 * and the review transition writes comments directly via the store — so a
 * decorator would need a second mechanism anyway. Each owning operation
 * (and the three legacy CLI handlers that still write through
 * `core/tasks.ts`/`core/comments.ts` directly) calls `emitAfterHook` after
 * its CONFIRMED durable effect:
 * - dry-run / no-op (null claim, empty push, scope refusal) → the caller
 *   does not call at all: no after-emission without an effect;
 * - partial success (update persisted, comment failed) → the caller emits
 *   ONLY the confirmed effect (`task.update`, never `task.comment`);
 * - generated SYSTEM comments (verify notes, bypass-audit, `cannot`
 *   reasons) are written via the store directly and never pass through an
 *   emitting call site — no hook cycle, by construction.
 *
 * Dedup is ACTION-SCOPED: the caller creates one `HookScope` per operation
 * invocation and the scope is discarded with it. Two separate actions in
 * one process each build their own scope, so repeated same-task actions
 * BOTH run (pinned by `emit.test.ts`); the scope only collapses a double
 * fire for the SAME effect inside one action (e.g. a nested dispatch).
 */
import { readProjectPointer } from "../../auth/project-pointer.js";
import {
  buildHookEnvelope,
  type HookAfterPayloads,
  type HookEvent,
  type HookPrePayloads,
  type HookTaskSnapshot,
} from "./envelope.js";
import {
  hookRoots,
  isHookConflict,
  refusedSibling,
  reportUnknownHookEvents,
  resolveHookFile,
} from "./discover.js";
import { ensureShippedDefaults, getDefaultHookSource } from "./defaults.js";
import { checkHookTrust } from "./trust.js";
import { HOOK_GUARD_ENV, runAfterHook, runPreHook } from "./runner.js";
import { formatBypassNotice, writeBypassAudit } from "./bypass.js";

export interface HookScope {
  seen: Set<string>;
}

/** One scope per operation invocation — discarded with it, never process-wide. */
export function createHookScope(): HookScope {
  return { seen: new Set() };
}

export interface EmitContext {
  projectDir: string;
  mode: "local" | "saas";
  userId?: string;
}

export interface EmitOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Explicit kill-switch: `VIBEFLOW_HOOKS=0` disables all hook emission.
 * Explicit config, never silent fallback — the test setup uses it for
 * hermeticity (hook unit tests opt back in per case), and operators get
 * the same escape hatch agents get for trust (`VIBEFLOW_TRUST_HOOKS=1`).
 */
function hooksDisabled(env: NodeJS.ProcessEnv): boolean {
  return env["VIBEFLOW_HOOKS"] === "0";
}

function hookScopeKey(
  event: HookEvent,
  payload: unknown,
  phase: "pre" | "after" = "after",
): string {
  let taskId = "-";
  if (payload !== null && typeof payload === "object" && "taskId" in payload) {
    const id = (payload as Record<string, unknown>)["taskId"];
    if (typeof id === "string" && id.length > 0) taskId = id;
  }
  return `${event}:${phase}:${taskId}`;
}

/**
 * Actor: explicit context user, then VIBEFLOW_ACTOR, then the same stable
 * per-user id the CLI uses (USER/USERNAME, falling back to "agent").
 */
export function resolveHookActor(ctx: EmitContext, env: NodeJS.ProcessEnv): string {
  if (ctx.userId) return ctx.userId;
  const override = env["VIBEFLOW_ACTOR"];
  if (override) return override;
  return env["USER"] ?? env["USERNAME"] ?? "agent";
}

/** boardId is null locally: a local board has no server-side identity. */
export function resolveHookBoardId(ctx: EmitContext): string | null {
  if (ctx.mode === "local") return null;
  try {
    return readProjectPointer(ctx.projectDir)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Generic extras for an after-hook (Stage 3 gap fix, ticket 431ee1c0):
 * the owner generic contract (envelope.ts header) promises every envelope
 * carries the full immutable task snapshot + activityObject +
 * instructions draft — but emitAfterHook used to take only (event,
 * payload), so every AFTER envelope carried task:null. Callers now pass
 * the CONFIRMED post-write record here; push/pull/verify pass nothing
 * (run intents: no single task exists, so task:null is CORRECT there).
 * The legacy `payload` stays byte-identical — these ride top-level fields.
 */
export interface AfterHookExtras {
  task?: HookTaskSnapshot;
  activityObject?: unknown;
  instructions?: string;
}

/**
 * Emit one after-hook. Returns the hook's instructions (0..1 strings) for
 * the caller to carry on its result. Failures are silent-apart-from-stderr
 * by design: after = fail OPEN, the write already happened.
 */
export async function emitAfterHook<E extends HookEvent>(
  ctx: EmitContext,
  scope: HookScope,
  event: E,
  payload: HookAfterPayloads[E],
  opts: EmitOptions = {},
  extra: AfterHookExtras = {},
): Promise<string[]> {
  const env = opts.env ?? process.env;
  if (hooksDisabled(env)) return [];
  // Reentrancy guard: a hook shelling out to `vibeflow ...` runs nested
  // commands with hooks disabled — nested WRITES still work, they just
  // emit no further hooks (cycle breaker, not a write lock).
  if (env[HOOK_GUARD_ENV] === "1") return [];

  const key = hookScopeKey(event, payload);
  if (scope.seen.has(key)) return [];
  scope.seen.add(key);

  const projectDir = ctx.projectDir;
  reportUnknownHookEvents(projectDir);

  // Refused extensions are LOUD, never silent: a `.js`/`.cjs` hook that
  // looks like policy but never runs is worse than no hook.
  const roots = hookRoots(projectDir, opts.home);
  for (const dir of [roots.project, roots.global]) {
    const bad = refusedSibling(`${dir}/after`, "after", event);
    if (bad) {
      process.stderr.write(
        `hook ${event}: HOOK_BAD_EXTENSION (${bad} — only *.mjs and .hook.mjs/.hook.mts/.hook.ts execute; rename it or it never runs)\n`,
      );
    }
  }

  // Shipped defaults always resolve (materialised to
  // ~/.vibeflow/hooks/defaults on version change); an explicit
  // project/global file wins by precedence inside resolveHookFile.
  ensureShippedDefaults(opts.home);

  const resolved = resolveHookFile(projectDir, "after", event, opts.home);
  // Same-level stdio+module collision: configuration error for this
  // invocation — diagnostic on stderr, no hook, and NO fallback to a
  // lower-level default (ADR-0006 Stage 1.5). After = fail OPEN.
  if (isHookConflict(resolved)) {
    process.stderr.write(
      `hook ${event}: HOOK_CONFIG_CONFLICT (${resolved.files.join(" and ")} all exist at ${resolved.root} level — keep exactly one) — continuing without hook\n`,
    );
    return [];
  }
  const file =
    resolved?.file ?? getDefaultHookSource(event, opts.home)?.file ?? null;
  if (!file) return [];
  const isProjectRoot = resolved ? resolved.root === "project" : false;
  const escapedRoot = resolved?.escapedRoot ?? false;
  // Shipped defaults are always stdio; only an explicit resolution carries
  // the module mode into the shared runner.
  const mode = resolved?.mode ?? "stdio";

  const trust = await checkHookTrust(file, {
    isProjectRoot,
    escapedRoot,
    home: opts.home,
    env,
  });
  if (!trust.trusted) return [];

  // Generic contract (envelope.ts header): the full task snapshot after
  // the write (or null where no single task exists — push/pull/verify run
  // intents) + the activityObject where one exists + the instructions
  // draft (empty post-write; the hook replaces it by returning one).
  // Same shape as the pre-gate input — the legacy payload is untouched.
  const envelope = buildHookEnvelope({
    event,
    phase: "after",
    boardId: resolveHookBoardId(ctx),
    actor: resolveHookActor(ctx, env),
    payload,
    task: extra.task ?? null,
    ...(extra.activityObject !== undefined
      ? { activityObject: extra.activityObject }
      : {}),
    instructions: extra.instructions ?? "",
  });
  const result = await runAfterHook(event, file, JSON.stringify(envelope), {
    cwd: projectDir,
    timeoutMs: opts.timeoutMs,
    env,
    mode,
  });
  if (!result.ran || !result.instructions) return [];
  return [result.instructions];
}

/**
 * Pre-gate input (Stage 2): the generic envelope extras for a gate check.
 * `payload` is INTENT (never a generated id); `task` is the full snapshot
 * where one exists (existing record pre-write, intent fields pre-create —
 * immutable by contract) or null where no single task exists (push/pull/
 * verify run intents); `activityObject` is the secondary record when one
 * exists (comment text, changed-keys, claim filters, …); `instructions`
 * is the agent-instruction draft the hook may replace (default "").
 * `bypass` + `command` carry `--no-verify` (universal audit + notice).
 */
export interface PreGateInput<E extends HookEvent> {
  payload: HookPrePayloads[E];
  task?: HookTaskSnapshot;
  activityObject?: unknown;
  instructions?: string;
  bypass?: boolean;
  command?: string;
}

/**
 * Pre-gate verdict. `allowed:false` ALWAYS refuses the gated write with
 * `code` + `reason` (fail-closed); `instructions` (when the hook replaced
 * the draft on allow) ride the success result like after-hook
 * instructions. `bypassed:true` means the gate was skipped by --no-verify
 * (notice printed, audit written) — the caller still runs after-hooks.
 */
export interface PreGateResult {
  allowed: boolean;
  code?: string;
  reason?: string;
  instructions: string[];
  bypassed: boolean;
}

const PRE_UNTRUSTED_COMMAND =
  "approve it once from an interactive terminal, or set VIBEFLOW_TRUST_HOOKS=1 for this run";

/**
 * Run the pre-gate for one gated invocation. Returns allow/deny as VALUES
 * — the caller translates deny into the existing refusal shape with a
 * non-zero exit. Fail-closed throughout: conflict, untrusted project
 * hook, malformed/timeout/loader failure, and explicit deny ALL refuse.
 * No hook file anywhere: allowed (nothing to enforce). `VIBEFLOW_HOOKS=0`
 * disables everything, including the gate.
 */
export async function emitPreHook<E extends HookEvent>(
  ctx: EmitContext,
  scope: HookScope,
  event: E,
  input: PreGateInput<E>,
  opts: EmitOptions = {},
): Promise<PreGateResult> {
  const env = opts.env ?? process.env;
  const none = { allowed: true, instructions: [], bypassed: false };
  if (hooksDisabled(env)) return none;

  // --no-verify: skip the gate LOUDLY (notice) + append-only audit record.
  // Never silent, never blocking — even the audit write cannot refuse.
  if (input.bypass === true) {
    const command = input.command ?? "cli";
    process.stderr.write(formatBypassNotice(event, command) + "\n");
    writeBypassAudit(
      { event, phase: "pre", command, reason: "--no-verify" },
      opts.home,
    );
    return { allowed: true, instructions: [], bypassed: true };
  }

  const key = hookScopeKey(event, input.payload, "pre");
  if (scope.seen.has(key)) return none;
  scope.seen.add(key);

  const projectDir = ctx.projectDir;
  reportUnknownHookEvents(projectDir);

  const roots = hookRoots(projectDir, opts.home);
  for (const dir of [roots.project, roots.global]) {
    const bad = refusedSibling(`${dir}/pre`, "pre", event);
    if (bad) {
      process.stderr.write(
        `hook ${event}: HOOK_BAD_EXTENSION (${bad} — only *.mjs and .hook.mjs/.hook.mts/.hook.ts execute; rename it or it never runs)\n`,
      );
    }
  }

  // Shipped defaults resolve (same materialisation as after); an explicit
  // project/global file wins by precedence inside resolveHookFile.
  ensureShippedDefaults(opts.home);

  const resolved = resolveHookFile(projectDir, "pre", event, opts.home);
  // Same-level stdio+module conflict is a configuration error. After =
  // skip-with-diagnostic (fail-open: the write happened); pre = REFUSE
  // (fail-closed: a misconfigured gate is not an open gate).
  if (isHookConflict(resolved)) {
    const names = resolved.files.join(" and ");
    process.stderr.write(
      `hook ${event}: HOOK_CONFIG_CONFLICT (${names} all exist at ${resolved.root} level — keep exactly one) — refusing gated write\n`,
    );
    return {
      allowed: false,
      code: "HOOK_CONFIG_CONFLICT",
      reason: `Pre-hook misconfigured: ${names} both exist — keep exactly one or remove both.`,
      instructions: [],
      bypassed: false,
    };
  }
  // No hook anywhere: nothing to enforce — allowed.
  if (!resolved) return none;
  const file = resolved.file;
  const isProjectRoot = resolved.root === "project";
  const escapedRoot = resolved.escapedRoot ?? false;
  // Shipped defaults are always stdio; only an explicit resolution carries
  // the module mode into the shared runner.
  const mode = resolved.mode ?? "stdio";

  // Trust: an untrusted project hook BLOCKS the gated write (it could be
  // policy the operator never approved). After-hooks only skip with a
  // notice — the write already happened, so there is nothing to protect.
  const trust = await checkHookTrust(file, {
    isProjectRoot,
    escapedRoot,
    home: opts.home,
    env,
  });
  if (!trust.trusted) {
    process.stderr.write(
      `hook ${event}: HOOK_PRE_UNTRUSTED (project hook ${file} is not trusted — ${PRE_UNTRUSTED_COMMAND}) — refusing gated write\n`,
    );
    return {
      allowed: false,
      code: "HOOK_PRE_UNTRUSTED",
      reason: `Pre-hook ${file} is not trusted — ${PRE_UNTRUSTED_COMMAND}.`,
      instructions: [],
      bypassed: false,
    };
  }

  const envelope = buildHookEnvelope({
    event,
    phase: "pre",
    boardId: resolveHookBoardId(ctx),
    actor: resolveHookActor(ctx, env),
    payload: input.payload,
    task: input.task ?? null,
    ...(input.activityObject !== undefined
      ? { activityObject: input.activityObject }
      : {}),
    instructions: input.instructions ?? "",
  });
  const result = await runPreHook(event, file, JSON.stringify(envelope), {
    cwd: projectDir,
    timeoutMs: opts.timeoutMs,
    env,
    mode,
  });
  if (result.allowed) {
    return {
      allowed: true,
      instructions:
        result.instructions !== undefined ? [result.instructions] : [],
      bypassed: false,
    };
  }
  // Explicit deny carries the HOOK's reason (already printed on stderr
  // above); gate failures carry the human fail-closed line.
  if (result.reason === "HOOK_PRE_DENIED") {
    return {
      allowed: false,
      code: "HOOK_PRE_DENIED",
      reason: result.hookReason ?? "Pre-hook denied the write.",
      instructions: [],
      bypassed: false,
    };
  }
  return {
    allowed: false,
    code: result.reason ?? "HOOK_PRE_FAILED",
    reason: preFailureMessage(event, result.reason ?? "HOOK_PRE_FAILED"),
    instructions: [],
    bypassed: false,
  };
}

/**
 * Shared pre-gate refusal mapping (Stage 2, ADR-0006): every gated
 * operation translates a deny into its existing refusal shape with the
 * gate's code + human reason — never a silent pass, never a renamed code.
 * Owner decision (ticket wla7ci2wzbgaj5dqsrvh1j4o): fail-closed, one doc.
 */
export function preGateRefusal(result: PreGateResult): {
  code: string;
  message: string;
} {
  return {
    code: result.code ?? "HOOK_PRE_FAILED",
    message: result.reason ?? "Pre-hook refused the write.",
  };
}

/** Human refusal line for gate failures (the hook's own deny text is separate). */
function preFailureMessage(event: HookEvent, code: string): string {
  switch (code) {
    case "HOOK_PRE_TIMEOUT":
      return `Pre-hook for ${event} timed out — refusing gated write (fail-closed).`;
    case "HOOK_PRE_TS_UNSUPPORTED":
      return `Pre-hook for ${event} needs TypeScript type stripping, unavailable on this runtime ${process.version} — refusing gated write (fail-closed).`;
    case "HOOK_PRE_NONZERO_EXIT":
      return `Pre-hook for ${event} exited non-zero — refusing gated write (fail-closed).`;
    case "HOOK_PRE_MALFORMED":
      return `Pre-hook for ${event} returned a malformed decision (need {"allow":true|false,...}) — refusing gated write (fail-closed).`;
    default:
      return `Pre-hook for ${event} failed (${code}) — refusing gated write (fail-closed).`;
  }
}
