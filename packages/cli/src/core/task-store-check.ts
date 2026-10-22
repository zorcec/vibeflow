/**
 * Store-integrity checker (ticket 8538344b).
 *
 * A `git add -A .vibeflow` once committed task files that still contained
 * git conflict markers. Those files are unparseable, so the CLI quarantined
 * them and the tasks silently vanished from every listing. This module is
 * the guard: it walks the .vibeflow tasks tree (date subdirectories plus
 * the flat layout) and fails on any parse error or conflict marker,
 * naming the offending paths.
 *
 * Two entry points share these rules: the `check:store` npm script
 * (scripts/check-store.mjs, dependency-free so it runs without a build)
 * and this module (importable, unit-tested). Keep the marker patterns in
 * sync between the two: a line starting with seven `<`, `=`, or `>` chars.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROTO_DIR, TASKS_DIR } from "./types.js";

export interface TaskStoreOffender {
  filePath: string;
  reason: string;
}

export interface TaskStoreCheckResult {
  ok: boolean;
  /** Files examined (JSON task files only; sidecars excluded). */
  checked: number;
  offenders: TaskStoreOffender[];
}

/** A line that opens an unresolved git merge conflict. */
const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m;

/**
 * Check one file's text. Returns the reason it offends, or null when clean.
 * Markers are reported before parse errors: a conflicted file fails both,
 * and the marker names the fix (resolve the merge) while a parse error does
 * not. A marker mid-line (e.g. `a >>>>>>> b` in a description) is data, not
 * a conflict — only a line START counts.
 */
export function checkTaskStoreText(text: string): string | null {
  const marker = CONFLICT_MARKER_RE.exec(text);
  if (marker && marker.index !== undefined) {
    const line = text.slice(0, marker.index).split("\n").length;
    const markerText = marker[0].slice(0, 7);
    return `git conflict marker on line ${line} (${markerText}…): resolve the merge before committing`;
  }
  try {
    JSON.parse(text);
  } catch (err) {
    return `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

function isTaskJsonFile(name: string): boolean {
  return name.endsWith(".json") && !name.endsWith(".auth.json");
}

function collectTaskJsonFiles(tasksDir: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Array<{
        name: string;
        isDirectory: () => boolean;
        isFile: () => boolean;
      }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile() && isTaskJsonFile(entry.name)) out.push(abs);
    }
  };
  visit(tasksDir);
  return out.sort();
}

/**
 * Walk the .vibeflow tasks tree under `projectDir` and check every file.
 * A missing tasks dir is NOT an offense (a fresh checkout has no store) —
 * the result is ok with zero checked. Never throws on unreadable files:
 * those are offenders, not crashes.
 */
export function checkTaskStore(projectDir: string): TaskStoreCheckResult {
  const tasksDir = join(projectDir, PROTO_DIR, TASKS_DIR);
  if (!existsSync(tasksDir)) return { ok: true, checked: 0, offenders: [] };
  const offenders: TaskStoreOffender[] = [];
  const files = collectTaskJsonFiles(tasksDir);
  for (const filePath of files) {
    let text: string;
    try {
      text = readFileSync(filePath, "utf-8");
    } catch (err) {
      offenders.push({
        filePath,
        reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const reason = checkTaskStoreText(text);
    if (reason !== null) offenders.push({ filePath, reason });
  }
  return { ok: offenders.length === 0, checked: files.length, offenders };
}

/** One line per offender, stable order — the pre-commit failure output. */
export function formatTaskStoreOffenders(result: TaskStoreCheckResult): string[] {
  return result.offenders.map((o) => `  ✗ ${o.filePath}: ${o.reason}`);
}
