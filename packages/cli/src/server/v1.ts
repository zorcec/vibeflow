/**
 * `/api/v1` local read alias (Phase 1).
 *
 * A THIN delegating mount over the existing handlers — one handler per
 * resource, never a second implementation (plan §6.4 #1). Each v1 read
 * route gates on its contract scope and then rewrites `req.url` to the
 * legacy path and calls `next()`, so the ONE existing handler serves the
 * response. This module therefore:
 * - never parses a request body,
 * - never reaches the task store (no `core/*` import — asserted by the
 *   drift guard),
 * - never reads an Authorization header (localhost trust is the model;
 *   inventing local auth is out of scope — the drift guard's
 *   bearer-allowlist is unchanged).
 *
 * Reads only: any other method+path under `/api/v1/*` gets a JSON 404, so
 * the alias adds no new capability. Writes land in Phase 3.
 *
 * Rollback is removing the `registerV1ReadAlias` call in server.ts — the
 * legacy routes are byte-for-byte untouched.
 */

import type { Express, NextFunction, Request, Response } from "express";
import {
  V1_OPERATIONS,
  isScopeName,
  parseScopeHeaderValue,
  requireScope,
  resolveLocalPrincipal,
  ScopeDeniedError,
  ScopeHeaderError,
  type Principal,
  type ScopeName,
} from "@vibeflow-tools/api-core";

/**
 * Registry op ids mounted as local reads in P1. Exactly the manifest's
 * `runnable: local-read` set — every one has a local HTTP handler today.
 */
export const V1_READ_IDS = [
  "list-tasks",
  "get-task",
  "list-comments",
  "list-files",
  "get-file",
  "get-project",
  "get-me",
  "get-settings",
  "get-changelog",
] as const;

export interface V1ReadBinding {
  id: string;
  method: string;
  /** Registry v1 path template, e.g. "/api/v1/tasks/{id}". */
  v1Path: string;
  /** Express route path, e.g. "/api/v1/tasks/:id". */
  v1ExpressPath: string;
  /** Contract scope (null = public read). */
  scope: ScopeName | null;
}

/** `/api/v1/tasks/{id}` → `/api/v1/tasks/:id`. */
export function v1TemplateToExpress(template: string): string {
  return template.replace(/\{(\w+)\}/g, ":$1");
}

/**
 * The P1 read bindings, derived from the generated registry (single
 * source) — a registry op the contract does not know cannot be mounted,
 * and a mounted op carries the contract's own scope.
 */
export function getV1ReadBindings(): V1ReadBinding[] {
  const wanted = new Set<string>(V1_READ_IDS);
  return V1_OPERATIONS.filter((op) => wanted.has(op.id)).map((op) => {
    if (op.method !== "GET") {
      throw new Error(`v1 read alias: ${op.id} is not a GET (${op.method})`);
    }
    let scope: ScopeName | null = null;
    if (op.scope !== null) {
      if (!isScopeName(op.scope)) {
        throw new Error(
          `v1 read alias: ${op.id} has a non-gateable scope ${JSON.stringify(op.scope)}`,
        );
      }
      scope = op.scope;
    }
    return {
      id: op.id,
      method: op.method,
      v1Path: op.v1Path,
      v1ExpressPath: v1TemplateToExpress(op.v1Path),
      scope,
    };
  });
}

/**
 * Map a v1 request path to the legacy path served by the ONE existing
 * handler. Operates on the raw (still-encoded) path so filenames and ids
 * round-trip byte-exact. The only shape rename is /api/v1/me → /api/user;
 * everything else is the prefix swap.
 */
export function toLegacyPath(v1Path: string): string {
  const prefix = "/api/v1";
  const rest = v1Path.startsWith(prefix) ? v1Path.slice(prefix.length) : v1Path;
  if (rest === "/me") return "/api/user";
  return `/api${rest}`;
}

export interface V1AliasOptions {
  /**
   * Principal resolver seam. Production default is the trusted local
   * principal (no token surface). Tests inject a scoped-down principal to
   * prove the scope gate denies — never a new HTTP auth mechanism.
   */
  resolvePrincipal?: (req: Request) => Principal;
}

/** JSON 404 for v1 paths with no P1 read binding (writes land in Phase 3). */
function v1NotFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found" });
}

/**
 * One delegating handler per resource. Gates on the binding's contract
 * scope, then rewrites to the legacy path and continues down the stack to
 * the ONE existing handler — no body parsing, no store access here.
 */
function makeAliasHandler(
  binding: V1ReadBinding,
  resolve: (req: Request) => Principal,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    // Scope header is cloud addressing (§3.3). Locally there is one
    // implicit project, so the value is validated (400 on malformed)
    // and otherwise discarded — never routed on.
    try {
      parseScopeHeaderValue(
        req.headers["x-vibeflow-scope"] as string | undefined,
      );
    } catch (err) {
      if (err instanceof ScopeHeaderError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
    try {
      requireScope(resolve(req), binding.scope);
    } catch (err) {
      if (err instanceof ScopeDeniedError) {
        res.status(err.status).json({ error: "Forbidden", code: err.code });
        return;
      }
      throw err;
    }
    // Delegate to the ONE existing handler: rewrite to the legacy path
    // (query string preserved) and continue down the stack.
    const q = req.url.indexOf("?");
    const rawPath = q === -1 ? req.url : req.url.slice(0, q);
    const query = q === -1 ? "" : req.url.slice(q);
    req.url = toLegacyPath(rawPath) + query;
    next();
  };
}

/**
 * Mount the read alias. Must be called BEFORE the legacy task/meta
 * registrations so the rewritten URL still reaches their layers via next().
 *
 * Routes are explicit string literals (not a registration loop) so the
 * drift guard's static scanner sees every handler: the guard asserts each
 * scanned /api/v1 handler matches exactly one registry op and each mounted
 * read op has exactly one handler.
 */
export function registerV1ReadAlias(
  app: Express,
  options?: V1AliasOptions,
): void {
  const resolve = options?.resolvePrincipal ?? (() => resolveLocalPrincipal());
  const byId = new Map(getV1ReadBindings().map((b) => [b.id, b]));
  const handler = (id: string): ReturnType<typeof makeAliasHandler> => {
    const binding = byId.get(id);
    if (!binding) throw new Error(`v1 read alias: unknown binding ${id}`);
    return makeAliasHandler(binding, resolve);
  };
  app.get("/api/v1/tasks", handler("list-tasks"));
  app.get("/api/v1/tasks/:id", handler("get-task"));
  app.get("/api/v1/tasks/:id/comments", handler("list-comments"));
  app.get("/api/v1/tasks/:id/files", handler("list-files"));
  app.get("/api/v1/tasks/:id/files/:fileId", handler("get-file"));
  app.get("/api/v1/project", handler("get-project"));
  app.get("/api/v1/me", handler("get-me"));
  app.get("/api/v1/settings", handler("get-settings"));
  app.get("/api/v1/changelog", handler("get-changelog"));
  // Reads only: anything else under /api/v1/* is not mounted yet.
  app.use("/api/v1", v1NotFound);
}
