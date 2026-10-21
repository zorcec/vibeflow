/**
 * Fill `commits[].authorEmail` at PUSH TIME, on the wire only.
 *
 * WHY: locally stored records often carry a commit SHA without the author's
 * email (the overlay records the SHA, not the identity). The server mirrors
 * whatever it receives, so those records stay email-less online — 1098 tasks
 * in the reference board. `vibeflow authors link` rewrites the LOCAL store,
 * but push never writes local data, so the same enrichment has to be possible
 * without touching disk.
 *
 * Best effort by design: resolution only works where the git history is
 * present (a shallow clone or another machine simply yields fewer emails).
 * A failed resolution must never fail the push or alter the record.
 */

import { execFileSync } from "node:child_process";

/** Abbreviated or full object names — never an option-looking string. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export interface CommitEntry {
  sha?: unknown;
  authorEmail?: unknown;
}

function commitsOf(record: Record<string, unknown>): unknown[] | null {
  const commits = record.commits;
  return Array.isArray(commits) ? commits : null;
}

function shaOf(entry: unknown): string {
  if (entry === null || typeof entry !== "object") return "";
  const sha = (entry as CommitEntry).sha;
  return typeof sha === "string" && SHA_RE.test(sha) ? sha : "";
}

function emailOf(entry: unknown): string {
  if (entry === null || typeof entry !== "object") return "";
  const email = (entry as CommitEntry).authorEmail;
  return typeof email === "string" ? email.trim() : "";
}

/** SHAs in one record that carry no author email yet. */
export function missingAuthorEmails(record: Record<string, unknown>): string[] {
  const commits = commitsOf(record);
  if (commits === null) return [];
  const out: string[] = [];
  for (const entry of commits) {
    const sha = shaOf(entry);
    if (sha !== "" && emailOf(entry) === "") out.push(sha);
  }
  return out;
}

/**
 * Resolve SHAs to author emails with ONE git invocation.
 *
 * `--no-walk` makes git answer only for the given commits instead of walking
 * history; `--` terminates options so a SHA-shaped string can never be read as
 * a flag. Any failure (no repo, shallow clone, unknown SHA) returns what was
 * resolved so far — the caller treats a miss as "leave it alone".
 */
export function resolveEmailsFromGit(
  shas: Iterable<string>,
  cwd: string,
): Map<string, string> {
  const unique = [...new Set(shas)].filter((sha) => SHA_RE.test(sha));
  const resolved = new Map<string, string>();
  if (unique.length === 0) return resolved;

  // git accepts a bounded number of arguments; chunk so a large board cannot
  // trip E2BIG and lose every email in the batch.
  const CHUNK = 512;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    try {
      const stdout = execFileSync(
        "git",
        ["log", "--no-walk", "--format=%H%x09%ae", ...batch, "--"],
        { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      );
      for (const line of stdout.split("\n")) {
        const [sha, email] = line.trim().split("\t");
        if (sha !== undefined && email !== undefined && email !== "") {
          resolved.set(sha, email);
        }
      }
    } catch {
      // Best effort: an unavailable history must not fail the push.
    }
  }
  return resolved;
}

/**
 * Return a record with `authorEmail` filled where it was missing.
 *
 * Returns the SAME object when nothing changed, so callers that hash the
 * result cannot accidentally observe a spurious difference. Existing emails
 * are never overwritten — the recorded identity wins over git's current one.
 */
export function applyEmails(
  record: Record<string, unknown>,
  emails: Map<string, string>,
): Record<string, unknown> {
  if (emails.size === 0) return record;
  const commits = commitsOf(record);
  if (commits === null) return record;

  let changed = false;
  const next = commits.map((entry) => {
    const sha = shaOf(entry);
    if (sha === "" || emailOf(entry) !== "") return entry;
    const email = emails.get(sha);
    if (email === undefined) return entry;
    changed = true;
    return { ...(entry as Record<string, unknown>), authorEmail: email };
  });

  return changed ? { ...record, commits: next } : record;
}

/** One git call for a whole push: every SHA any of the records is missing. */
export function resolveEmailsForRecords(
  records: Record<string, unknown>[],
  cwd: string,
): Map<string, string> {
  const shas: string[] = [];
  for (const record of records) shas.push(...missingAuthorEmails(record));
  return resolveEmailsFromGit(shas, cwd);
}
