// Flaky-test reporting bucket (child f3b5058e).
//
// A `@flaky`-marked spec still RUNS — never skipped. When it fails, the
// failure lands in a separate `flaky` bucket that does NOT fail the gate,
// while a genuine red in the same run still does. Every quarantined failure
// prints as `FLAKY (not failing the gate): …` and appends one machine-
// readable line (path + spec + worker count + timestamp) to the flake log,
// so a ticket can be filed from it. Reporting half only: this module never
// changes exit codes, it classifies.
//
// No new `@flaky` tags are added here — a tag on a spec that is actually
// broken would launder a real red. If you find one, file it, don't tag it.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { availableParallelism } from "node:os";

export interface FailureRecord {
  file: string;
  name: string;
  failed: boolean;
  /** True when the failing spec is marked `@flaky` in its source. */
  flaky: boolean;
}

export interface GateSummary {
  /** Genuine reds — these fail the gate. */
  failed: FailureRecord[];
  /** Quarantined flakes — reported, never gate-failing. */
  flaky: FailureRecord[];
  pass: boolean;
}

/** True when spec source carries the `@flaky` marker. */
export function isFlakySpec(source: string): boolean {
  return /(^|\s)@flaky\b/.test(source);
}

/**
 * Slice the source block around a failing spec name so the marker check is
 * scoped to that spec — a file with one `@flaky` test must not launder the
 * failures of its healthy neighbours.
 */
export function specBlock(source: string, testName: string): string {
  const at = source.indexOf(testName);
  if (at === -1) return source;
  return source.slice(Math.max(0, at - 500), at + testName.length);
}

/** Split failures into gate-failing reds vs quarantined flakes. */
export function summarizeGate(records: FailureRecord[], _workers: number): GateSummary {
  const failed = records.filter((r) => r.failed && !r.flaky);
  const flaky = records.filter((r) => r.failed && r.flaky);
  return { failed, flaky, pass: failed.length === 0 };
}

export function formatFlakyLine(r: Pick<FailureRecord, "file" | "name">): string {
  return `FLAKY (not failing the gate): ${r.file} > ${r.name}`;
}

export function flakeLogLine(
  r: Pick<FailureRecord, "file" | "name">,
  workers: number,
  timestamp: string = new Date().toISOString(),
): string {
  return JSON.stringify({
    path: r.file,
    spec: r.name,
    workers,
    timestamp,
  });
}

/**
 * Append one machine-readable flake line. `write` exists for tests — the
 * default appends to `$FLAKE_LOG` (or `reports/flakes.log`), creating the
 * directory, so a ticket can be filed from the log.
 */
export function appendFlakeLog(
  r: Pick<FailureRecord, "file" | "name">,
  workers: number,
  write?: (line: string) => void,
): void {
  const line = flakeLogLine(r, workers);
  if (write) {
    write(line);
    return;
  }
  const dest = process.env.FLAKE_LOG ?? "reports/flakes.log";
  mkdirSync(dirname(dest), { recursive: true });
  appendFileSync(dest, `${line}\n`, "utf8");
}

function workerCount(): number {
  const fromEnv = Number(process.env.FLAKE_WORKERS ?? "");
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  try {
    return availableParallelism();
  } catch {
    return 1;
  }
}

// --- Vitest reporter (reporting half) ---------------------------------------
// Registered alongside the default reporter; it never alters results or exit
// codes, it only classifies failures into the buckets above.

interface TaskLike {
  name?: string;
  type?: string;
  result?: { state?: string };
  task?: TaskLike;
  tasks?: TaskLike[];
  file?: { filepath?: string };
  filepath?: string;
  content?: string;
}

function failingTests(node: TaskLike, file: string, out: FailureRecord[], read: (f: string) => string): void {
  for (const child of node.tasks ?? []) {
    if (child.type === "suite" || child.tasks) {
      failingTests(child, file, out, read);
    } else if (child.result?.state === "fail") {
      const name = child.name ?? "<unknown>";
      let flaky = false;
      try {
        flaky = isFlakySpec(specBlock(read(file), name));
      } catch {
        flaky = false; // unreadable source => genuine red (fail closed)
      }
      out.push({ file, name, failed: true, flaky });
    }
  }
}

export function createFlakyReporter(readFile?: (f: string) => string) {
  const read = readFile ?? ((f: string) => readFileSync(f, "utf8"));
  return {
    name: "flaky-bucket",
    onFinished(files?: TaskLike[]) {
      const records: FailureRecord[] = [];
      for (const f of files ?? []) {
        const file = f.filepath ?? f.file?.filepath ?? "<unknown>";
        failingTests(f, file, records, read);
      }
      if (records.length === 0) return;
      const summary = summarizeGate(records, workerCount());
      for (const flake of summary.flaky) {
        console.log(formatFlakyLine(flake));
        appendFlakeLog(flake, workerCount());
      }
      if (summary.flaky.length > 0) {
        console.log(
          `flaky bucket: ${summary.flaky.length} quarantined (gate ${summary.pass ? "still green" : "RED on genuine failures"}) — see ${process.env.FLAKE_LOG ?? "reports/flakes.log"}`,
        );
      }
    },
  };
}

/** Vitest reporter entry point (must be a class for vitest's loader). */
export class FlakyBucketReporter {
  onFinished(files?: TaskLike[]): void {
    createFlakyReporter().onFinished(files);
  }
}

export default FlakyBucketReporter;
