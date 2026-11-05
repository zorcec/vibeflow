/**
 * Hook activity vocabulary — the api-core-free leaf (ADR-0007).
 *
 * `HookActivity`, `HookSurface`, `HookIntentPayloads` and
 * `HookConfirmedPayloads` live here — not in `envelope.ts` — so the public
 * authoring boundary (`src/hooks.ts`, packed into the self-contained
 * `dist/hooks.d.ts`) can import them WITHOUT dragging the store's `Task`
 * (and therefore `@vibeflow-tools/api-core`, private and never published)
 * into the tarball. Anything that needs `Task` reads `envelope.ts`, never
 * this file. Pinned by `hooks-package.test.ts`: a tarball consumer has no
 * api-core to resolve.
 */

/** Which surface ran the tool: `"cli"` | `"mcp"`. */
export type HookSurface = "cli" | "mcp";

/**
 * The deliberately-8 activity set. An activity is a unit of work with an
 * intent side and a confirmed side; a TOOL key is a file — the mapping is
 * many-to-one (see `tools.ts`). No `task.list`, no files/links/boards/mcp —
 * an activity exists only when something must be gated or narrated.
 */
export type HookActivity =
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
 * result). The phase split is load-bearing: claim is atomic,
 * commentId/verify results exist only post-write, so before and after
 * payloads are distinct types, not one shared shape.
 */
export interface HookConfirmedPayloads {
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
 * Before-phase INTENT payloads: what the invocation intends, BEFORE any
 * durable effect. No generated ids (no task id on create, no commentId,
 * no verdict) — a before-hook that needs the result must allow and read
 * the after-hook. Claim before-gate is invocation-level over the claim
 * FILTERS (atomic claim preserved — no preview-then-update, no
 * reservation protocol). Same deliberately-8 activity set; distinct from
 * confirmed payloads on purpose.
 */
export interface HookIntentPayloads {
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
