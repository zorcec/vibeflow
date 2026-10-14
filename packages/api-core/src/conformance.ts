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

import { createNormalizeContext, normalizeResponse } from "./normalize.js";

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
  expect: {
    status: number;
    /** Envelope shape for the normalizer. */
    shape?: string;
    /** Assertion the normalized body must satisfy. */
    conformance?: string;
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
 *   their v1 paths (see `toSurfacePath`); every other entry is reported
 *   skipped BY NAME with its manifest `cloudSkipReason`.
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
        const template = toSurfacePath(entry, c.request.path, surface);
        const path = resolvePath(template, entry.seed, entry.id);
        const { status, body } = await transport.fetchJson(
          c.request.method,
          path,
          { query: c.request.query, body: c.request.body, timeoutMs },
        );
        if (status !== c.expect.status) {
          report.failed.push({
            entryId: entry.id,
            caseName: c.name,
            outcome: "failed",
            detail: `expected status ${c.expect.status}, got ${status} at ${where}`,
          });
          continue;
        }
        if (c.expect.shape) {
          normalizeResponse(c.expect.shape, body, ctx, where);
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
