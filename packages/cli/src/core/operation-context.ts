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
 * Writes are mostly out of scope: mutating operations keep resolving
 * through `resolveOperationPorts` (local) until P4 routes the remaining
 * remote writes — EXCEPT the claim, which P3 (ticket 6452504d) routes
 * through `resolveClaimPorts` below (remote adapter in saas mode). The
 * remote adapter refuses every other write loudly so a misrouted write
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

/**
 * The ports a CLAIM runs against (ticket 6452504d, parent e7482da5).
 *
 * The truthful-claim rule: `mode: "saas"` claims through the remote
 * adapter's versioned agent-claim POST (the server owns selection and the
 * write, so a claim can never report success when the remote refused);
 * `mode: "local"` claims through the file-backed atomic primitive. An
 * explicitly injected `ctx.store` always wins (tests, and callers that
 * already resolved a store). Like reads, a remote claim failure refuses —
 * it never falls back to list-then-PATCH or to the local files.
 */
export function resolveClaimPorts(ctx: OperationContext): OperationPorts {
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

/**
 * The ports a TASK WRITE runs against (ticket efcd6992, P4).
 *
 * The authoritative-write rule: `mode: "saas"` creates/updates/comments
 * through the remote adapter's POST/PATCH (the board owns the write, so a
 * write can never report success when the remote refused, and no local
 * ghost file is minted on either success or refusal); `mode: "local"`
 * writes through the file-backed store. An explicitly injected `ctx.store`
 * always wins (tests, and callers that already resolved a store). A remote
 * write failure refuses — it never falls back to the local files.
 *
 * Reads stay on `resolveReadPorts` (the existence check runs against the
 * authoritative store either way); only the mutation resolves here.
 */
export function resolveWritePorts(ctx: OperationContext): OperationPorts {
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
