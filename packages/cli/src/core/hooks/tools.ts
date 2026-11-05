/**
 * Hook tool registry — the ONE table the whole v2 contract hangs off (ADR-0007).
 *
 * A hook key is a TOOL (`tasks`, `auth.login`, `create_task`), not an
 * internal event. The registry says, per key: which surface it belongs to,
 * whether a `.before` gate file is meaningful for it, and whether an
 * `.after` narration file exists for it. Discovery (`discover.ts`),
 * the invocation boundary (`invocation.ts`), the contract test
 * (`tool-contract.test.ts`) and the docs table (`docs/agent-hooks.md`)
 * all read THIS table — never a second spelling.
 *
 * Surfaces: `"cli"` = a canonical commander command path; `"mcp"` = an
 * MCP tool name from `src/mcp/manifest.ts`. `pull` is the only key shared
 * by both surfaces (CLI `pull` and MCP `pull` run the same operation);
 * the envelope's `surface` field tells a hook which one it is. No
 * cross-surface fallback exists (`create_task.after.mjs` does not fall
 * back to `tasks.after.mjs`).
 *
 * `.before` is supported only for GATEABLE tools — a tool whose
 * invocation performs one of the 8 activities. A `.before` file for any
 * other tool is refused loudly (`HOOK_NOT_GATEABLE`), never silently
 * ignored. `.after` is supported for every tool except `mcp` (the client
 * owns the process lifetime; a hook that sometimes runs is a trap) and
 * the `authors` container (a node with no action of its own).
 */
import type { HookActivity } from "./envelope.js";

export type HookSurface = "cli" | "mcp";

/** Why a cell is unsupported — the exact diagnostic code surfaced. */
export type HookUnsupportedReason = "not-gateable" | "no-after" | "container";

export type HookCell =
  | { status: "supported"; activities: HookActivity[] }
  | { status: "unsupported"; reason: HookUnsupportedReason };

export interface HookToolSpec {
  /** Canonical key, e.g. `tasks`, `auth.login`, `create_task`. */
  tool: string;
  surface: HookSurface;
  /** Hidden CLI spellings that resolve to this key (e.g. `login`). */
  aliases?: string[];
  before: HookCell;
  after: HookCell;
}

const gateable = (...activities: HookActivity[]): HookCell => ({
  status: "supported",
  activities,
});
const readAfter = (after?: HookCell): HookCell =>
  after ?? { status: "supported", activities: [] };
const notGateable: HookCell = {
  status: "unsupported",
  reason: "not-gateable",
};
const noAfter: HookCell = { status: "unsupported", reason: "no-after" };
const container: HookCell = { status: "unsupported", reason: "container" };

/**
 * The §2 tables, verbatim. `tasks` is the only multi-activity CLI key:
 * one hook execution per (tool, activity) unit of work.
 */
export const HOOK_TOOLS: readonly HookToolSpec[] = [
  // ── CLI (15 canonical + 1 container) ──────────────────────────────
  {
    tool: "tasks",
    surface: "cli",
    before: gateable("task.create", "task.update", "task.claim", "task.delete", "task.comment"),
    after: gateable("task.create", "task.update", "task.claim", "task.delete", "task.comment"),
  },
  { tool: "pull", surface: "cli", before: gateable("pull"), after: gateable("pull") },
  { tool: "push", surface: "cli", before: gateable("push"), after: gateable("push") },
  { tool: "verify", surface: "cli", before: gateable("verify"), after: gateable("verify") },
  { tool: "serve", surface: "cli", before: notGateable, after: readAfter() },
  { tool: "kanban", surface: "cli", before: notGateable, after: readAfter() },
  { tool: "mcp", surface: "cli", before: notGateable, after: noAfter },
  { tool: "changelog", surface: "cli", before: notGateable, after: readAfter() },
  { tool: "openapi", surface: "cli", before: notGateable, after: readAfter() },
  { tool: "telemetry", surface: "cli", before: notGateable, after: readAfter() },
  { tool: "auth", surface: "cli", before: notGateable, after: readAfter() },
  {
    tool: "auth.login",
    surface: "cli",
    aliases: ["login"],
    before: notGateable,
    after: readAfter(),
  },
  {
    tool: "auth.logout",
    surface: "cli",
    aliases: ["logout"],
    before: notGateable,
    after: readAfter(),
  },
  {
    tool: "auth.status",
    surface: "cli",
    aliases: ["status"],
    before: notGateable,
    after: readAfter(),
  },
  { tool: "authors.link", surface: "cli", before: notGateable, after: readAfter() },
  { tool: "authors", surface: "cli", before: container, after: container },
  // ── MCP (13) ──────────────────────────────────────────────────────
  { tool: "create_task", surface: "mcp", before: gateable("task.create"), after: gateable("task.create") },
  { tool: "update_task", surface: "mcp", before: gateable("task.update"), after: gateable("task.update") },
  { tool: "claim_next_task", surface: "mcp", before: gateable("task.claim"), after: gateable("task.claim") },
  { tool: "add_comment", surface: "mcp", before: gateable("task.comment"), after: gateable("task.comment") },
  { tool: "verify_task", surface: "mcp", before: gateable("verify"), after: gateable("verify") },
  { tool: "pull", surface: "mcp", before: gateable("pull"), after: gateable("pull") },
  { tool: "list_tasks", surface: "mcp", before: notGateable, after: readAfter() },
  { tool: "get_task", surface: "mcp", before: notGateable, after: readAfter() },
  { tool: "get_file", surface: "mcp", before: notGateable, after: readAfter() },
  { tool: "attach_file", surface: "mcp", before: notGateable, after: readAfter() },
  { tool: "get_project", surface: "mcp", before: notGateable, after: readAfter() },
  { tool: "start_kanban", surface: "mcp", before: notGateable, after: readAfter() },
  { tool: "get_integration_guide", surface: "mcp", before: notGateable, after: readAfter() },
];

const byTool = new Map<string, HookToolSpec>();
for (const spec of HOOK_TOOLS) {
  const existing = byTool.get(spec.tool);
  if (existing && existing.surface !== spec.surface) continue; // per-surface lookup below
  if (!existing) byTool.set(spec.tool, spec);
}

/** Find a registry row by canonical key (aliases resolve via {@link canonicalHookTool}). */
export function findHookTool(tool: string, surface?: HookSurface): HookToolSpec | undefined {
  const canonical = canonicalHookTool(tool);
  if (surface === undefined) return byTool.get(canonical);
  return HOOK_TOOLS.find((s) => s.tool === canonical && s.surface === surface);
}

/**
 * Resolve a hidden CLI spelling to its canonical key (`login` →
 * `auth.login`). Unknown names pass through unchanged (the caller reports
 * `HOOK_UNKNOWN_TOOL`).
 */
export function canonicalHookTool(name: string): string {
  for (const spec of HOOK_TOOLS) {
    if (spec.aliases?.includes(name)) return spec.tool;
  }
  return name;
}

/**
 * The canonical CLI tool for an activity (the `ctx.hookScope ??
 * createHookScope(...)` fallback in operation call sites, so direct
 * unit-test callers keep working with the activity's CLI key).
 */
export function defaultToolForActivity(a: HookActivity, surface: HookSurface = "cli"): string {
  const row = HOOK_TOOLS.find(
    (s) => s.surface === surface && s.after.status === "supported" && s.after.activities.includes(a),
  );
  if (row) return row.tool;
  const any = HOOK_TOOLS.find(
    (s) => s.after.status === "supported" && s.after.activities.includes(a),
  );
  if (!any) throw new Error(`HOOK_TOOLS: no tool covers activity ${a}`);
  return any.tool;
}

/** All tools with a supported cell for the phase (`mcp`/`authors` excluded from after). */
export function hookableTools(phase: "before" | "after"): string[] {
  return HOOK_TOOLS.filter((s) => s[phase].status === "supported").map((s) => `${s.surface}:${s.tool}`);
}
