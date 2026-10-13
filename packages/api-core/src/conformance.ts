/**
 * Conformance runner skeleton, LOCAL SIDE ONLY (plan §6.1, Phase 0).
 *
 * Drives the local board over HTTP (v1 operations translated to their current
 * local handler paths by the caller via the manifest's `local` mapping —
 * there is no /api/v1 mount yet; that is P1), normalizes each response, and
 * compares. Design constraints from the ticket:
 * - Fail fast: boot and every request carry hard timeouts and reject with a
 *   named error instead of hanging (the web e2e harness stalls on a missing
 *   TEST Postgres on 5433 — this runner must never reproduce that mode).
 * - Writes are manifest DATA in Phase 0 but never executed: the runner
 *   reports them as explicitly skipped with their target phase, so a skip
 *   is a decision, not a hole.
 * - The runner takes an injected `fetchJson` transport so api-core stays
 *   dependency-free and the CLI-side test owns server boot/teardown.
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

/** One manifest entry (one v1 operation). */
export interface ManifestEntry {
  id: string;
  v1: { method: string; path: string };
  local: { method: string; path: string } | null;
  /** "local-read" entries execute in Phase 0; everything else is reported skipped. */
  runnable: string;
  phase: number;
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
 * Run every runnable case of the given entries. Non-"local-read" entries are
 * reported skipped with their target phase — never executed, never silent.
 */
export async function runConformance(
  entries: ManifestEntry[],
  transport: RunnerTransport,
  options?: { timeoutMs?: number },
): Promise<RunnerReport> {
  const timeoutMs = options?.timeoutMs ?? RUNNER_DEFAULT_TIMEOUT_MS;
  const report: RunnerReport = { passed: [], failed: [], skipped: [] };
  for (const entry of entries) {
    if (entry.runnable !== "local-read" || entry.local === null) {
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
        const path = resolvePath(c.request.path, entry.seed, entry.id);
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
