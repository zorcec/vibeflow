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
import { buildHookEnvelope, type HookAfterPayloads, type HookEvent } from "./envelope.js";
import {
  hookRoots,
  isHookConflict,
  refusedSibling,
  reportUnknownHookEvents,
  resolveHookFile,
} from "./discover.js";
import { ensureShippedDefaults, getDefaultHookSource } from "./defaults.js";
import { checkHookTrust } from "./trust.js";
import { HOOK_GUARD_ENV, runAfterHook } from "./runner.js";

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

function hookScopeKey(event: HookEvent, payload: unknown): string {
  let taskId = "-";
  if (payload !== null && typeof payload === "object" && "taskId" in payload) {
    const id = (payload as Record<string, unknown>)["taskId"];
    if (typeof id === "string" && id.length > 0) taskId = id;
  }
  return `${event}:after:${taskId}`;
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
        `hook ${event}: HOOK_BAD_EXTENSION (${bad} — only *.mjs executes; rename it or it never runs)\n`,
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
      `hook ${event}: HOOK_CONFIG_CONFLICT (${resolved.stdioFile} and ${resolved.moduleFile} both exist at ${resolved.root} level — keep exactly one) — continuing without hook\n`,
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

  const envelope = buildHookEnvelope({
    event,
    phase: "after",
    boardId: resolveHookBoardId(ctx),
    actor: resolveHookActor(ctx, env),
    payload,
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
