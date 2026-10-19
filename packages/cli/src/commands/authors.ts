/**
 * `vibeflow authors link` — attach git author emails to local task commits.
 *
 * WHY: a comment or commit can only be attributed to a real account if the
 * local record carries an email. The store never had one (measured: zero '@'
 * anywhere in 1746 tasks), so pushed history could only be displayed as a name
 * string. The email is the claim key: once someone is a member of the board,
 * their existing rows attach to their account with no re-push.
 *
 * WHY a separate command instead of enriching during push: `push` must never
 * write task data (it deletes nothing either). Enrichment is a deliberate,
 * reviewable change to git-tracked files, so it gets its own command, its own
 * diff, and its own commit.
 *
 * WHY the AUTHOR email: attribution is about who wrote the change. The
 * committer is an incidental (rebase/apply) identity, and mailmap rewriting
 * would hide the address the repo actually recorded.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { isValidAuthorEmail } from "../core/types.js";
import { listTasksWithPaths } from "../core/tasks.js";

export interface AuthorsLinkOptions {
  dryRun?: boolean;
  /** Injected for tests; defaults to the real git resolver. */
  resolveEmail?: (sha: string) => string | null;
}

export interface AuthorsLinkResult {
  /** Commit entries that gained an authorEmail in this run. */
  linked: number;
  /** Entries that already carried the correct value. */
  alreadyLinked: number;
  /** Entries whose sha could not be resolved in this repository. */
  unresolved: number;
  /** Count of entries that already carried a DIFFERENT email (never overwritten). */
  conflicts: number;
  /** The conflicting entries themselves, for the report. */
  conflictDetails: Array<{ taskId: string; sha: string; existing: string; resolved: string }>;
  /** False when git cannot run here; nothing is written in that case. */
  gitAvailable: boolean;
  /** Tasks rewritten on disk (0 for a dry run). */
  filesChanged: number;
  /** Distinct shas resolved through git (the real store has 1434). */
  distinctShas: number;
}

interface CommitLike {
  sha?: unknown;
  authorEmail?: unknown;
  [k: string]: unknown;
}

/**
 * Resolve a commit sha to its original author email.
 *
 * Batched because the real store has 1434 distinct shas: one `git log` per sha
 * would be 1434 processes. Escapes nothing itself — `execFileSync` passes argv
 * directly, so a sha cannot be interpreted as a flag or shell word.
 */
export function gitAuthorEmailResolver(cwd: string): (sha: string) => string | null {
  const cache = new Map<string, string | null>();
  return (sha: string): string | null => {
    if (cache.has(sha)) return cache.get(sha) ?? null;
    let email: string | null = null;
    try {
      email = execFileSync("git", ["-C", cwd, "log", "-1", "--no-walk", "--format=%ae", sha], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
    } catch {
      // Object absent (rewritten history) or git unavailable: unresolved,
      // never guessed. The caller reports it.
      email = null;
    }
    cache.set(sha, email);
    return email;
  };
}

/**
 * Pure core: apply resolution to one parsed record, returning the number of
 * changes and mutating `record` in place (the caller decides whether to write).
 */
export function linkRecord(
  taskId: string,
  record: Record<string, unknown>,
  resolveEmail: (sha: string) => string | null,
  result: AuthorsLinkResult,
): boolean {
  const commits = record.commits;
  if (!Array.isArray(commits)) return false;
  let changed = false;
  for (const raw of commits) {
    if (typeof raw !== "object" || raw === null) continue;
    const commit = raw as CommitLike;
    const sha = typeof commit.sha === "string" ? commit.sha : "";
    if (sha === "") continue;
    const resolved = resolveEmail(sha);
    if (resolved === null || !isValidAuthorEmail(resolved)) {
      result.unresolved += 1;
      continue;
    }
    const existing = typeof commit.authorEmail === "string" ? commit.authorEmail : "";
    if (existing === resolved) {
      result.alreadyLinked += 1;
      continue;
    }
    if (existing !== "") {
      // A different recorded value is data, not an error to correct: report it
      // and leave the record untouched rather than silently rewriting history.
      result.conflicts += 1;
      result.conflictDetails.push({ taskId, sha, existing, resolved });
      continue;
    }
    commit.authorEmail = resolved;
    result.linked += 1;
    changed = true;
  }
  return changed;
}

export function authorsLink(dir: string, opts: AuthorsLinkOptions = {}): AuthorsLinkResult {
  const result: AuthorsLinkResult = {
    linked: 0,
    alreadyLinked: 0,
    unresolved: 0,
    conflicts: 0,
    conflictDetails: [],
    filesChanged: 0,
    distinctShas: 0,
    gitAvailable: true,
  };

  // Precheck BEFORE any write: enriching is pointless without git, and a
  // half-written store is worse than an honest refusal. Callers check
  // `gitAvailable` and exit non-zero.
  if (opts.resolveEmail === undefined) {
    try {
      execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      result.gitAvailable = false;
      return result;
    }
  }

  const resolveEmail = opts.resolveEmail ?? gitAuthorEmailResolver(dir);
  const tasks = listTasksWithPaths(dir);

  // Resolve distinct shas first so the cache is warm and the count reported
  // matches what git was actually asked for.
  const shas = new Set<string>();
  for (const t of tasks) {
    // SAFETY: `listTasksWithPaths` returns parsed task JSON objects plus a
    // `filePath` string; both shapes are plain objects, so widening to a
    // string-keyed record only restates what the JSON already is.
    const commits = (t as unknown as Record<string, unknown>).commits;
    if (!Array.isArray(commits)) continue;
    for (const c of commits) {
      const sha = (c as CommitLike)?.sha;
      if (typeof sha === "string" && sha !== "") shas.add(sha);
    }
  }
  result.distinctShas = shas.size;

  for (const task of tasks) {
    // SAFETY: same parsed-JSON object as above — the cast exists only to read
    // keys dynamically (`id`, `filePath`, `commits`), never to change shape.
    const record = task as unknown as Record<string, unknown>;
    const taskId = typeof record.id === "string" ? record.id : "";
    if (taskId === "") continue;
    const filePath = typeof record.filePath === "string" ? record.filePath : "";
    if (filePath === "") continue;
    // Link the ON-DISK object, never the listed one: `listTasksWithPaths` adds
    // an in-memory `filePath`, and writing that back would put an absolute
    // local path into a git-tracked file. A dry run mutates only this copy, so
    // it reports the same counts without touching disk.
    //
    // Deliberately a RAW parse, not `readTaskFile`: that helper NORMALIZES
    // (fills `description: ""`, drops an empty `links` array), so writing its
    // output back would rewrite unrelated fields and bury the real change in
    // the diff. `JSON.parse` of the file text preserves key order and every
    // value exactly as committed.
    //
    // SAFETY: the file is a task JSON object; the cast only allows dynamic
    // key access and the object is written back unchanged apart from the
    // authorEmail keys linkRecord adds.
    const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (!linkRecord(taskId, onDisk, resolveEmail, result)) continue;
    if (opts.dryRun === true) {
      result.filesChanged += 1;
      continue;
    }
    writeFileSync(filePath, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");
    result.filesChanged += 1;
  }

  return result;
}

export function formatAuthorsLinkResult(result: AuthorsLinkResult, dryRun: boolean): string {
  const lines = [
    `  Linked ${result.linked} commit author email(s) across ${result.filesChanged} task file(s).`,
    `  Already linked: ${result.alreadyLinked} | Unresolved: ${result.unresolved} | Conflicts: ${result.conflicts}`,
    `  Distinct commit shas resolved through git: ${result.distinctShas}`,
  ];
  for (const c of result.conflictDetails.slice(0, 5)) {
    lines.push(`  ! ${c.taskId} ${c.sha.slice(0, 8)}: kept ${c.existing} (git says ${c.resolved})`);
  }
  if (result.conflicts > 5) {
    lines.push(`  … and ${result.conflicts - 5} more conflict(s)`);
  }
  if (!result.gitAvailable) {
    lines.push("  git is unavailable here (not a repository?) — nothing was written.");
  }
  if (dryRun) lines.push("  Dry run: no files written.");
  else if (result.filesChanged > 0) {
    lines.push("  Review and commit .vibeflow/tasks/ — it is git-tracked.");
  }
  return lines.join("\n");
}

/** Read a file's raw text (exported for tests that assert byte preservation). */
export function readRaw(path: string): string {
  return readFileSync(path, "utf8");
}
