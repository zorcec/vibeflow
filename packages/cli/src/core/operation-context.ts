/**
 * Authoritative read-backend resolution (ticket d7b9dc13, parent e7482da5).
 *
 * After P1 the operations layer exists, but reads could still disagree about
 * which store is authoritative: the CLI read the remote board when a token
 * was present while local MCP always read the local files — the split that
 * produced phantom records (a task visible in one surface and absent in the
 * other) and let a stale local copy look current.
 *
 * This module is the ONE place that decision lives. It is deliberately NOT a
 * second mode resolver: `getMode()` (`auth/mode.ts`, token present ? saas :
 * local) stays the only thing that reads credentials into a mode. Everything
 * here is a pure function of that already-resolved mode, so the decision is
 * explicit at each read call site and testable without credentials.
 *
 * Rules:
 * - `resolveReadBackend(mode)`: "saas" reads remote, "local" reads local.
 * - `resolveReadPorts(ctx)`: the store a READ runs against. An explicitly
 *   injected `ctx.store` always wins (tests, and callers that already
 *   resolved a store); otherwise the backend decides — saas gets the
 *   remote read adapter, local gets the shared file-backed adapter.
 * - Fail-closed: a remote refusal is returned as a refusal. Nothing here
 *   ever falls back to the local store after a remote failure — a stale
 *   local copy must never be presented as current.
 *
 * Writes are out of scope: mutating operations keep resolving through
 * `resolveOperationPorts` (local) until P3/P4 route remote writes. The
 * remote adapter below refuses every write loudly so a misrouted write
 * fails instead of landing on the wrong backend.
 */
import type { OperationContext } from "./operations.js";
import {
  localTaskStore,
  resolveOperationPorts,
  type OperationPorts,
  type TaskStore,
} from "./task-store.js";
import { remoteTaskStore } from "./remote-task-store.js";

/** Which store is authoritative for reads under an already-resolved mode. */
export type ReadBackend = "local" | "remote";

/**
 * THE authoritative-read decision. Pure: mode in, backend out, no I/O, no
 * credential reads. Both the CLI read paths and the local MCP operations
 * resolve through here so one mode can never mean two sources of truth.
 */
export function resolveReadBackend(mode: OperationContext["mode"]): ReadBackend {
  return mode === "saas" ? "remote" : "local";
}

/**
 * The ports a READ runs against. Explicit injection wins; otherwise the
 * backend decides. The artifacts port is never remote — there is no remote
 * artifact store, and portable read modules must not need one.
 */
export function resolveReadPorts(ctx: OperationContext): OperationPorts {
  if (ctx.store) {
    return {
      store: ctx.store,
      artifacts: ctx.artifacts ?? localTaskStore,
    };
  }
  if (resolveReadBackend(ctx.mode) === "remote") {
    const store: TaskStore = remoteTaskStore;
    return { store, artifacts: ctx.artifacts ?? localTaskStore };
  }
  return resolveOperationPorts(ctx);
}
