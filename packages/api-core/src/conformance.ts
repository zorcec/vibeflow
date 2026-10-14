/**
 * Conformance runner, per-surface (plan §6.1; P3 step 14 adds the cloud surface).
 *
 * Drives one board surface over HTTP and normalizes each response for
 * comparison. On `local` (the default) v1 operations run through their
 * current local handler paths from the manifest's `local` mapping; on
 * `cloud` they run against the v1 paths directly (the caller authenticates
 * the transport with a PAT + board scope). Design constraints:
 * - Fail fast: boot and every request carry hard timeouts and reject with a
 *   named error instead of hanging (the web e2e harness stalls on a missing
 *   TEST Postgres on 5433 — this runner must never reproduce that mode).
 * - A skip is a decision, not a hole: on `local`, writes are manifest DATA
 *   in Phase 0 but never executed (reported skipped with their target
 *   phase); on `cloud`, entries outside the entry's `surfaces` are reported
 *   skipped BY NAME with the manifest's `cloudSkipReason` — never silent.
 * - The runner takes an injected `fetchJson` transport so api-core stays
 *   dependency-free and the caller owns server boot/teardown/auth.
 */

import { createNormalizeContext, normalizeResponse, NormalizeError } from "./normalize.js";

/** One runnable case from the manifest. */
export interface ManifestCase {
  name: string;
  /** Local request (translated from the v1 op by the manifest's `local` map). */
  request: {
    method: string;
    /** May contain {taskId} / {commentId} / {filename} placeholders. */
    path: string;
    query?: Record<string, string>;
    /** Placeholder values are substituted from `seed`. */
    body?: unknown;
  };
  /**
   * Cloud-surface request override. Case paths are authored against the
   * `local` mapping, which cannot express v1-only wire shapes (id-addressed
   * file routes, header-carried uploads): on `cloud` this replaces the
   * translated request instead. Placeholders resolve from the same seed.
   * `rawBody` sends bytes verbatim (never JSON-encoded) with `headers`.
   * Absent on `local` — the local surface always runs `request`.
   */
  cloudRequest?: {
    method?: string;
    path?: string;
    query?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  };
  expect: {
    status: number;
    /** Envelope shape for the normalizer. */
    shape?: string;
    /** Assertion the normalized body must satisfy. */
    conformance?: string;
  };
  /**
   * Cloud-surface status override. Some cases assert local-legacy
   * conventions (200-empty for unknown ids, router-level 400s) that the
   * contract's own v1 error convention contradicts (404/400 per openapi) —
   * the override documents the v1-correct expectation instead of hiding
   * the divergence. Shape still validates from `expect.shape`. Absent on
   * `local` — the local surface always asserts `expect.status`.
   */
  expectCloud?: {
    status: number;
  };
}

/** Surface a manifest entry's cases execute on. */
export type ConformanceSurface = "local" | "cloud";

/** One manifest entry (one v1 operation). */
export interface ManifestEntry {
  id: string;
  v1: { method: string; path: string };
  local: { method: string; path: string } | null;
  /** "local-read" entries execute in Phase 0; everything else is reported skipped. */
  runnable: string;
  phase: number;
  /**
   * Surfaces whose v1 op exists and whose cases execute there. Absent
   * means local-only (the pre-surfaces manifest): the cloud run skips the
   * entry with a fallback reason naming its phase and runnable label.
   */
  surfaces?: ConformanceSurface[];
  /**
   * Named reason reported for every skipped case when `cloud` is not in
   * `surfaces` (e.g. local-only ops, P4 MCP). Required by the drift guard
   * for cloud-skipped entries — a cloud skip without a reason fails the suite.
   */
  cloudSkipReason?: string;
  shape?: string;
  seed?: Record<string, string>;
  cases: ManifestCase[];
}

/** Transport injected by the caller (owns boot, teardown, and HTTP). */
export interface RunnerTransport {
  fetchJson(
    method: string,
    path: string,
    options?: {
      query?: Record<string, string>;
      body?: unknown;
      /** Raw (non-JSON) body, sent verbatim — for byte-upload cases. */
      rawBody?: string;
      /** Extra headers (e.g. content-type + x-filename for raw uploads). */
      headers?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<{ status: number; body: unknown; rawBytes?: Uint8Array }>;
}

export interface CaseResult {
  entryId: string;
  caseName: string;
  outcome: "passed" | "failed" | "skipped";
  detail?: string;
}

export interface RunnerReport {
  passed: CaseResult[];
  failed: CaseResult[];
  skipped: CaseResult[];
}

export const RUNNER_DEFAULT_TIMEOUT_MS = 5000;

/**
 * Substitute {placeholders} in a path from the entry's seed table.
 * Unknown placeholders throw — a silently un-substituted path would test
 * the wrong resource and pass vacuously.
 */
export function resolvePath(
  template: string,
  seed: Record<string, string> | undefined,
  where: string,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = seed?.[name];
    if (value === undefined) {
      throw new Error(
        `manifest entry ${where}: no seed value for placeholder ${match}`,
      );
    }
    return encodeURIComponent(value);
  });
}

/**
 * Rewrite a manifest case path to the surface under test. Case paths are
 * authored against the `local` mapping (or already against v1 for
 * handler-less ops); on `cloud` the local static prefix becomes the v1
 * static prefix — e.g. `/api/tasks/{taskId}/comments` under entry
 * get-task (`local` /api/tasks/{taskId}, `v1` /api/v1/tasks/{id}) becomes
 * `/api/v1/tasks/{taskId}/comments`, whose placeholders still resolve from
 * the entry seed. Paths that do not start on the local base (already-v1
 * case paths, handler-less entries) pass through untouched.
 */
export function toSurfacePath(
  entry: ManifestEntry,
  casePath: string,
  surface: ConformanceSurface,
): string {
  if (surface !== "cloud" || entry.local === null) return casePath;
  const localBase = entry.local.path.split("{")[0] as string;
  const v1Base = entry.v1.path.split("{")[0] as string;
  if (localBase === v1Base) return casePath;
  if (localBase.endsWith("/")) {
    if (casePath.startsWith(localBase)) {
      return v1Base + casePath.slice(localBase.length);
    }
    return casePath;
  }
  if (casePath === localBase) return v1Base;
  if (casePath.startsWith(localBase + "/")) {
    return v1Base + casePath.slice(localBase.length);
  }
  return casePath;
}

/**
 * Assert the v1 error envelope ({ error: string, ... }) — the shape an
 * `expectCloud` divergence asserts in place of the data shape. A 404 with
 * an HTML body (misconfigured route) or an empty body must not pass as a
 * "correct" 404: the contract's error convention is machine-readable.
 */
function assertErrorEnvelope(body: unknown, where: string): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new NormalizeError(
      `expected v1 error envelope { error } in ${where}, got ${typeof body}`,
    );
  }
  if (typeof (body as Record<string, unknown>)["error"] !== "string") {
    throw new NormalizeError(
      `expected v1 error envelope { error: string } in ${where}`,
    );
  }
}

/** Named reason for a cloud skip taken from the manifest, never invented. */
function cloudSkipReasonFor(entry: ManifestEntry): string {
  if (entry.cloudSkipReason) return entry.cloudSkipReason;
  return (
    `not on the cloud v1 surface ` +
    `(phase ${entry.phase}, runnable=${entry.runnable}) — entry declares no cloudSkipReason`
  );
}

/**
 * Run every runnable case of the given entries on the selected surface.
 *
 * - `local` (default): bit-identical to the Phase 0 gate — `local-read`
 *   entries with a local handler execute; everything else is reported
 *   skipped with its target phase. Never executed, never silent.
 * - `cloud`: entries whose `surfaces` include `"cloud"` execute against
 *   their v1 paths (see `toSurfacePath`); a case-level `cloudRequest`
 *   replaces the translated request where the local-authored path cannot
 *   express the v1 wire shape (id-addressed files, header-carried uploads).
 *   Every other entry is reported skipped BY NAME with its manifest
 *   `cloudSkipReason`.
 *
 * The skip/run decision comes from the manifest (`runnable`/`local` on
 * local, `surfaces` on cloud) — never from a hard-coded op list here.
 */
export async function runConformance(
  entries: ManifestEntry[],
  transport: RunnerTransport,
  options?: { timeoutMs?: number; surface?: ConformanceSurface },
): Promise<RunnerReport> {
  const timeoutMs = options?.timeoutMs ?? RUNNER_DEFAULT_TIMEOUT_MS;
  const surface = options?.surface ?? "local";
  const report: RunnerReport = { passed: [], failed: [], skipped: [] };
  for (const entry of entries) {
    if (surface === "cloud") {
      if (!entry.surfaces?.includes("cloud")) {
        const why = cloudSkipReasonFor(entry);
        for (const c of entry.cases) {
          report.skipped.push({
            entryId: entry.id,
            caseName: c.name,
            outcome: "skipped",
            detail: why,
          });
        }
        continue;
      }
    } else if (entry.runnable !== "local-read" || entry.local === null) {
      const why =
        entry.local === null
          ? `no local HTTP handler (phase ${entry.phase})`
          : `runnable=${entry.runnable} (phase ${entry.phase})`;
      for (const c of entry.cases) {
        report.skipped.push({
          entryId: entry.id,
          caseName: c.name,
          outcome: "skipped",
          detail: why,
        });
      }
      continue;
    }
    const ctx = createNormalizeContext();
    for (const c of entry.cases) {
      const where = `${entry.id}/${c.name}`;
      try {
        // On cloud a case-level `cloudRequest` replaces the translated
        // local-authored request (v1-only wire shapes); otherwise the
        // manifest request is translated and sent as before.
        const cr = surface === "cloud" ? c.cloudRequest : undefined;
        const method = cr?.method ?? c.request.method;
        const template =
          cr?.path ?? toSurfacePath(entry, c.request.path, surface);
        const query = cr?.query ?? c.request.query;
        const body = cr?.body !== undefined ? cr.body : c.request.body;
        const path = resolvePath(template, entry.seed, entry.id);
        const { status, body: responseBody } = await transport.fetchJson(
          method,
          path,
          {
            query,
            body,
            rawBody: cr?.rawBody,
            headers: cr?.headers,
            timeoutMs,
          },
        );
        const want =
          surface === "cloud" ? (c.expectCloud?.status ?? c.expect.status) : c.expect.status;
        if (status !== want) {
          report.failed.push({
            entryId: entry.id,
            caseName: c.name,
            outcome: "failed",
            detail: `expected status ${want}, got ${status} at ${where}`,
          });
          continue;
        }
        if (c.expect.shape) {
          // A cloud status divergence asserts the v1 error envelope, not
          // the data shape: the `expect` shape describes the local 2xx
          // path, and an error body must never validate as data (nor pass
          // without any body assertion at all).
          if (
            surface === "cloud" &&
            c.expectCloud?.status !== undefined &&
            c.expectCloud.status !== c.expect.status
          ) {
            assertErrorEnvelope(responseBody, where);
          } else {
            normalizeResponse(c.expect.shape, responseBody, ctx, where);
          }
        }
        report.passed.push({
          entryId: entry.id,
          caseName: c.name,
          outcome: "passed",
        });
      } catch (err) {
        report.failed.push({
          entryId: entry.id,
          caseName: c.name,
          outcome: "failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return report;
}
