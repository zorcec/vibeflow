/**
 * Invocation boundary — the (tool, activity) execution rule (ADR-0007).
 *
 * One hook execution per (tool, activity) unit of work; an invocation
 * with no durable effect narrates exactly once with `activity: null`.
 * The boundary is deliberately small and explicit: no ambient globals,
 * no AsyncLocalStorage. The CLI `toolAction` wrapper and the MCP
 * `invokeManifestTool` dispatch own the begin/finish pairing; operations
 * only read the scope the boundary created.
 *
 * Rules (all pinned by `invocation.test.ts`):
 * - `scope.seen.size === 0` at finish ⇒ exactly one null-activity after
 *   hook (this is how `kanban`, `serve`, reads and `auth` are hooked);
 *   any recorded effect suppresses it, so it can never double-fire.
 * - `ok === false` (refusals set the exit code before returning) ⇒ no
 *   after hook at all.
 * - `dryRun === true` ⇒ no after hook (no emission without a confirmed
 *   effect — the dry-run rule from v1, unchanged).
 * - A bypassed gate means `scope.seen` stays empty for that activity,
 *   but the after hook for the (bypassed) effect still runs from the
 *   operation — so `scope.seen` is non-empty by finish and no extra
 *   null-activity execution fires. Pinned, not assumed.
 */
import {
  createHookScope,
  emitAfterHook,
  type EmitOptions,
  type HookScope,
} from "./emit.js";
import type { HookSurface, HookTaskSnapshot } from "./envelope.js";
import { findHookTool } from "./tools.js";

export type { HookSurface };
export type { HookScope };

export interface ToolInvocation {
  tool: string;
  surface: HookSurface;
}

export interface ToolInvocationHandle {
  tool: string;
  surface: HookSurface;
  scope: HookScope;
  /** Set by the body once the target resolves (project dir + mode for the emit ctx). */
  target?: { projectDir: string; mode: "local" | "saas" };
}

/** Outcome the body reports: ok, the null-activity payload halves, dry-run. */
export interface ToolOutcome {
  ok?: boolean;
  task?: HookTaskSnapshot;
  activityObject?: unknown;
  dryRun?: boolean;
}

/**
 * Begin one tool invocation: creates the scope the body threads into every
 * `OperationContext` it builds (the body sets `handle.target` once
 * resolved). The tool SHOULD be a HOOK_TOOLS row — the contract test pins
 * the table against the commander tree and the MCP manifest, so drift
 * cannot ship — but an unknown key is NOT a throw: the scanner reports
 * `HOOK_UNKNOWN_TOOL` for stray files and discovery simply misses, so a
 * probe/future tool keeps working unhooked instead of crashing the call.
 */
export function beginToolInvocation(inv: ToolInvocation): ToolInvocationHandle {
  const spec = findHookTool(inv.tool, inv.surface);
  const tool = spec ? spec.tool : inv.tool;
  return { tool, surface: inv.surface, scope: createHookScope({ tool, surface: inv.surface }) };
}

/**
 * Finish one tool invocation: fires the null-activity after hook iff the
 * invocation succeeded, was not a dry-run, and emitted no activity.
 * Returns the hook's instructions (0..1 strings) for the caller to
 * surface (`--json` payload / MCP `successPayload` / dim stderr).
 */
export async function finishToolInvocation(
  handle: ToolInvocationHandle,
  outcome: ToolOutcome,
  opts: EmitOptions = {},
): Promise<string[]> {
  const target = handle.target;
  if (!target) return [];
  if (outcome.ok === false) return [];
  if (outcome.dryRun === true) return [];
  if (handle.scope.seen.size > 0) return [];
  return emitAfterHook(
    { projectDir: target.projectDir, mode: target.mode },
    handle.scope,
    null,
    null,
    opts,
    {
      ...(outcome.task !== undefined ? { task: outcome.task } : {}),
      ...(outcome.activityObject !== undefined ? { activityObject: outcome.activityObject } : {}),
    },
  );
}
