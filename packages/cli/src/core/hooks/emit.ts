/**
 * Shared hook dispatch helper — the ONE path every emit site uses (ADR-0007).
 *
 * Activities are OPERATION-OWNED (not TaskStore-emitted): `push`/`pull`/
 * `verify` are not store methods, online delete never calls a store delete,
 * and the review transition writes comments directly via the store — so a
 * decorator would need a second mechanism anyway. Each owning operation
 * calls `emitAfterHook` after its CONFIRMED durable effect:
 * - dry-run / no-op (null claim, empty push, scope refusal) → the caller
 *   does not call at all: no after-emission without an effect;
 * - partial success (update persisted, comment failed) → the caller emits
 *   ONLY the confirmed effect (`task.update`, never `task.comment`);
 * - generated SYSTEM comments (verify notes, bypass-audit, `cannot`
 *   reasons) are written via the store directly and never pass through an
 *   emitting call site — no hook cycle, by construction.
 *
 * Discovery is TOOL-SCOPED: `scope.tool` (set once per invocation by
 * `beginToolInvocation`) drives which file runs; `activity` only selects
 * the payload. A `kanban.after.mjs` never runs for `tasks`.
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
  type HookActivity,
  type HookConfirmedPayloads,
  type HookIntentPayloads,
  type HookSurface,
  type HookTaskSnapshot,
} from "./envelope.js";
import {
  hookRoots,
  isHookConflict,
  reportUnrunnableHookFiles,
  resolveHookFile,
  type HookRootsOptions,
} from "./discover.js";
import { checkHookTrust } from "./trust.js";
import { HOOK_GUARD_ENV, runAfterHook, runBeforeHook } from "./runner.js";
import { formatBypassNotice, writeBypassAudit } from "./bypass.js";

export interface HookScope {
  /** Canonical tool key driving discovery (never an alias). */
  tool: string;
  surface: HookSurface;
  seen: Set<string>;
}

export interface ToolInvocation {
  tool: string;
  surface: HookSurface;
}

/** One scope per operation invocation — discarded with it, never process-wide. */
export function createHookScope(inv: ToolInvocation = { tool: "tasks", surface: "cli" }): HookScope {
  return { tool: inv.tool, surface: inv.surface, seen: new Set() };
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
  shippedDir?: HookRootsOptions["shippedDir"];
  bundleUrl?: HookRootsOptions["bundleUrl"];
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
  activity: HookActivity | null,
  payload: unknown,
  phase: "before" | "after" = "after",
): string {
  let taskId = "-";
  if (payload !== null && typeof payload === "object" && "taskId" in payload) {
    const id = (payload as Record<string, unknown>)["taskId"];
    if (typeof id === "string" && id.length > 0) taskId = id;
  }
  return `${activity ?? "null"}:${phase}:${taskId}`;
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
 * Generic extras for an after-hook: the owner generic contract
 * (envelope.ts header) promises every envelope carries the full immutable
 * task snapshot + activityObject + instructions draft. Callers pass the
 * CONFIRMED post-write record here; push/pull/verify pass nothing (run
 * intents: no single task exists, so task:null is CORRECT there). The
 * legacy `payload` stays byte-identical — these ride top-level fields.
 */
export interface AfterHookExtras {
  task?: HookTaskSnapshot;
  activityObject?: unknown;
  instructions?: string;
}

/** Warn-once registry for the missing shipped-defaults tree (per process). */
let warnedShippedMissing = false;

/** Test seam: re-arm the shipped-missing warning. */
export function resetShippedMissingWarning(): void {
  warnedShippedMissing = false;
}

/**
 * Resolve the hook file for (scope.tool, phase) with diagnostics:
 * scan-based unrunnable-file reporting (replaces the per-lookup
 * refusedSibling loop), conflict diagnostics, and the loud
 * HOOK_SHIPPED_DEFAULTS_MISSING line when no shipped tree resolves.
 * Returns the file + root + mode, or null when no hook runs.
 */
function resolveHookWithDiagnostics(
  ctx: EmitContext,
  scope: HookScope,
  phase: "before" | "after",
  opts: EmitOptions,
): { file: string; root: string; escapedRoot: boolean; mode: "stdio" | "module" | "module-ts" } | null {
  const projectDir = ctx.projectDir;
  reportUnrunnableHookFiles(projectDir, opts);

  const resolved = resolveHookFile(projectDir, scope.tool, phase, opts);
  // Same-level stdio+module collision: configuration error for this
  // invocation — diagnostic on stderr, no hook, and NO fallback to a
  // lower-level default. After = skip (fail-open); before = refuse
  // (fail-closed) — the caller applies its phase policy.
  if (isHookConflict(resolved)) {
    process.stderr.write(
      `hook ${scope.tool}: HOOK_CONFIG_CONFLICT (${resolved.files.join(" and ")} all exist at ${resolved.root} level — keep exactly one) — continuing without hook\n`,
    );
    return { file: "", root: resolved.root, escapedRoot: false, mode: "stdio" };
  }
  if (resolved) {
    // A shipped file that symlinks out is refused loudly, never trusted.
    if (resolved.root === "shipped" && resolved.escapedRoot) {
      process.stderr.write(
        `hook ${scope.tool}: HOOK_SHIPPED_ESCAPED (${resolved.file} escapes the shipped defaults via symlink — not running)\n`,
      );
      return null;
    }
    return { file: resolved.file, root: resolved.root, escapedRoot: resolved.escapedRoot, mode: resolved.mode };
  }
  // No hook anywhere: if the shipped tree itself is missing, say so
  // LOUDLY (silent default loss is the most likely regression of the
  // whole in-package-defaults change) — but only then. A present tree
  // with no file for this key (e.g. no .before defaults, by design) is
  // a normal miss, not a warning.
  const roots = hookRoots(projectDir, opts);
  if (roots.shipped === null && !warnedShippedMissing) {
    warnedShippedMissing = true;
    process.stderr.write(
      `hook ${scope.tool}: HOOK_SHIPPED_DEFAULTS_MISSING (no hooks/defaults with a VERSION marker next to the bundle) — continuing without default hook\n`,
    );
  }
  return null;
}

/**
 * Emit the null-activity read narration for an operation that performed a
 * read with no durable effect (ADR-0007 §5.2): the tool comes from the
 * invocation scope (set by the CLI wrapper / MCP dispatch) so the same
 * operation narrates as `tasks` on the CLI and `list_tasks` on MCP;
 * direct callers without a scope fall back to `fallbackTool`. Returns the
 * hook's instructions for the operation result, or [] when nothing ran.
 */
export async function emitReadHook(
  ctx: EmitContext,
  scope: HookScope | undefined,
  fallbackTool: string,
  extra: AfterHookExtras = {},
): Promise<string[]> {
  const resolved = scope ?? createHookScope({ tool: fallbackTool, surface: "cli" });
  return emitAfterHook(ctx, resolved, null, null, {}, extra);
}

/**
 * Emit one after-hook. Returns the hook's instructions (0..1 strings) for
 * the caller to carry on its result. Failures are silent-apart-from-stderr
 * by design: after = fail OPEN, the write already happened.
 */
export async function emitAfterHook<A extends HookActivity | null>(
  ctx: EmitContext,
  scope: HookScope,
  activity: A,
  payload: A extends HookActivity ? HookConfirmedPayloads[A] : null,
  opts: EmitOptions = {},
  extra: AfterHookExtras = {},
): Promise<string[]> {
  const env = opts.env ?? process.env;
  if (hooksDisabled(env)) return [];
  // Reentrancy guard: a hook shelling out to `vibeflow ...` runs nested
  // commands with hooks disabled — nested WRITES still work, they just
  // emit no further hooks (cycle breaker, not a write lock).
  if (env[HOOK_GUARD_ENV] === "1") return [];

  const key = hookScopeKey(activity, payload);
  if (scope.seen.has(key)) return [];
  scope.seen.add(key);

  const found = resolveHookWithDiagnostics(ctx, scope, "after", opts);
  // Conflict is reported above; after = fail-open skip either way.
  if (!found || !found.file) return [];
  const file = found.file;
  const isProjectRoot = found.root === "project";

  const trust = await checkHookTrust(file, {
    isProjectRoot,
    escapedRoot: found.escapedRoot,
    home: opts.home,
    env,
  });
  if (!trust.trusted) return [];

  // Generic contract (envelope.ts header): the full task snapshot after
  // the write (or null where no single task exists — push/pull/verify run
  // intents) + the activityObject where one exists + the instructions
  // draft (empty post-write; the hook replaces it by returning one).
  // Same shape as the before-gate input — the legacy payload is untouched.
  const envelope = buildHookEnvelope({
    tool: scope.tool,
    surface: scope.surface,
    activity,
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
  const result = await runAfterHook(scope.tool, file, JSON.stringify(envelope), {
    cwd: ctx.projectDir,
    timeoutMs: opts.timeoutMs,
    env,
    mode: found.mode,
  });
  if (!result.ran || !result.instructions) return [];
  return [result.instructions];
}

/**
 * Before-gate input: the generic envelope extras for a gate check.
 * `payload` is INTENT (never a generated id); `task` is the full snapshot
 * where one exists (existing record pre-write, intent fields pre-create —
 * immutable by contract) or null where no single task exists (push/pull/
 * verify run intents); `activityObject` is the secondary record when one
 * exists (comment text, changed-keys, claim filters, …); `instructions`
 * is the agent-instruction draft the hook may replace (default "").
 * `bypass` + `command` carry `--no-verify` (universal audit + notice).
 */
export interface BeforeGateInput<A extends HookActivity> {
  payload: HookIntentPayloads[A];
  task?: HookTaskSnapshot;
  activityObject?: unknown;
  instructions?: string;
  bypass?: boolean;
  command?: string;
}

/**
 * Before-gate verdict. `allowed:false` ALWAYS refuses the gated write with
 * `code` + `reason` (fail-closed); `instructions` (when the hook replaced
 * the draft on allow) ride the success result like after-hook
 * instructions. `bypassed:true` means the gate was skipped by --no-verify
 * (notice printed, audit written) — the caller still runs after-hooks.
 */
export interface BeforeGateResult {
  allowed: boolean;
  code?: string;
  reason?: string;
  instructions: string[];
  bypassed: boolean;
}

const BEFORE_UNTRUSTED_COMMAND =
  "approve it once from an interactive terminal, or set VIBEFLOW_TRUST_HOOKS=1 for this run";

/**
 * Run the before-gate for one gated invocation. Returns allow/deny as
 * VALUES — the caller translates deny into the existing refusal shape with
 * a non-zero exit. Fail-closed throughout: conflict, untrusted project
 * hook, malformed/timeout/loader failure, and explicit deny ALL refuse.
 * No hook file anywhere: allowed (nothing to enforce). `VIBEFLOW_HOOKS=0`
 * disables everything, including the gate.
 */
export async function emitBeforeHook<A extends HookActivity>(
  ctx: EmitContext,
  scope: HookScope,
  activity: A,
  input: BeforeGateInput<A>,
  opts: EmitOptions = {},
): Promise<BeforeGateResult> {
  const env = opts.env ?? process.env;
  const none = { allowed: true, instructions: [], bypassed: false };
  if (hooksDisabled(env)) return none;

  // --no-verify: skip the gate LOUDLY (notice) + append-only audit record.
  // Never silent, never blocking — even the audit write cannot refuse.
  if (input.bypass === true) {
    const command = input.command ?? "cli";
    process.stderr.write(formatBypassNotice(scope.tool, command) + "\n");
    writeBypassAudit(
      { tool: scope.tool, activity, phase: "before", command, reason: "--no-verify" },
      opts.home,
    );
    return { allowed: true, instructions: [], bypassed: true };
  }

  const key = hookScopeKey(activity, input.payload, "before");
  if (scope.seen.has(key)) return none;
  scope.seen.add(key);

  const found = resolveHookWithDiagnostics(ctx, scope, "before", opts);
  // Same-level stdio+module conflict is a configuration error. After =
  // skip-with-diagnostic (fail-open: the write happened); before = REFUSE
  // (fail-closed: a misconfigured gate is not an open gate).
  if (found && !found.file) {
    return {
      allowed: false,
      code: "HOOK_CONFIG_CONFLICT",
      reason: `Before-hook misconfigured for ${scope.tool} — keep exactly one file per level or remove both.`,
      instructions: [],
      bypassed: false,
    };
  }
  // No hook anywhere: nothing to enforce — allowed.
  if (!found) return none;
  const file = found.file;
  const isProjectRoot = found.root === "project";

  // Trust: an untrusted project hook BLOCKS the gated write (it could be
  // policy the operator never approved). After-hooks only skip with a
  // notice — the write already happened, so there is nothing to protect.
  // (A shipped escape is already refused above with HOOK_SHIPPED_ESCAPED;
  // project/global escapes are refused here via the shared escape rule.)
  const trust = await checkHookTrust(file, {
    isProjectRoot,
    escapedRoot: found.escapedRoot,
    home: opts.home,
    env,
  });
  if (!trust.trusted) {
    process.stderr.write(
      `hook ${scope.tool}: HOOK_BEFORE_UNTRUSTED (project hook ${file} is not trusted — ${BEFORE_UNTRUSTED_COMMAND}) — refusing gated write\n`,
    );
    return {
      allowed: false,
      code: "HOOK_BEFORE_UNTRUSTED",
      reason: `Before-hook ${file} is not trusted — ${BEFORE_UNTRUSTED_COMMAND}.`,
      instructions: [],
      bypassed: false,
    };
  }

  const envelope = buildHookEnvelope({
    tool: scope.tool,
    surface: scope.surface,
    activity,
    phase: "before",
    boardId: resolveHookBoardId(ctx),
    actor: resolveHookActor(ctx, env),
    payload: input.payload,
    task: input.task ?? null,
    ...(input.activityObject !== undefined
      ? { activityObject: input.activityObject }
      : {}),
    instructions: input.instructions ?? "",
  });
  const result = await runBeforeHook(scope.tool, file, JSON.stringify(envelope), {
    cwd: ctx.projectDir,
    timeoutMs: opts.timeoutMs,
    env,
    mode: found.mode,
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
  if (result.reason === "HOOK_BEFORE_DENIED") {
    return {
      allowed: false,
      code: "HOOK_BEFORE_DENIED",
      reason: result.hookReason ?? "Before-hook denied the write.",
      instructions: [],
      bypassed: false,
    };
  }
  return {
    allowed: false,
    code: result.reason ?? "HOOK_BEFORE_FAILED",
    reason: beforeFailureMessage(scope.tool, result.reason ?? "HOOK_BEFORE_FAILED"),
    instructions: [],
    bypassed: false,
  };
}

/**
 * Shared before-gate refusal mapping (ADR-0007): every gated operation
 * translates a deny into its existing refusal shape with the gate's code
 * + human reason — never a silent pass, never a renamed code.
 */
export function beforeGateRefusal(result: BeforeGateResult): {
  code: string;
  message: string;
} {
  return {
    code: result.code ?? "HOOK_BEFORE_FAILED",
    message: result.reason ?? "Before-hook refused the write.",
  };
}

/** Human refusal line for gate failures (the hook's own deny text is separate). */
function beforeFailureMessage(tool: string, code: string): string {
  switch (code) {
    case "HOOK_BEFORE_TIMEOUT":
      return `Before-hook for ${tool} timed out — refusing gated write (fail-closed).`;
    case "HOOK_BEFORE_TS_UNSUPPORTED":
      return `Before-hook for ${tool} needs TypeScript type stripping, unavailable on this runtime ${process.version} — refusing gated write (fail-closed).`;
    case "HOOK_BEFORE_NONZERO_EXIT":
      return `Before-hook for ${tool} exited non-zero — refusing gated write (fail-closed).`;
    case "HOOK_BEFORE_MALFORMED":
      return `Before-hook for ${tool} returned a malformed decision (need {"allow":true|false,...}) — refusing gated write (fail-closed).`;
    default:
      return `Before-hook for ${tool} failed (${code}) — refusing gated write (fail-closed).`;
  }
}
