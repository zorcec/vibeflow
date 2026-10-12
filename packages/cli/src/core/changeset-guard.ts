import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * A single banned-content hit inside a pending changeset file.
 */
export interface ChangesetViolation {
  /** Short rule name (stable, used in failure output). */
  rule: string;
  /** The offending text as matched. */
  match: string;
}

interface BannedRule {
  name: string;
  pattern: RegExp;
}

/**
 * Markers that prove a changeset entry is about the private product
 * (online kanban / web app / SaaS backend), not the public CLI surface.
 * Public-repo changesets must be customer-facing public-CLI text only:
 * no SaaS wording, no private-monorepo references, no web-app internals,
 * no internal ticket ids, no local filesystem paths.
 *
 * Deliberately NOT banned: "presence" and "Locked by". Presence
 * (who is in which part of a task) is a genuine public CLI board feature
 * shipped in 0.20.0 for multi-session local boards, and "Locked by" now
 * appears only where its removal is described or asserted. Banning either
 * word would flag legitimate public entries.
 */
export const CHANGESET_BANNED_RULES: BannedRule[] = [
  { name: "saas-wording", pattern: /\bsaas\b/i },
  { name: "private-monorepo", pattern: /vibeflow-private/ },
  { name: "web-app-path", pattern: /packages\/web\// },
  { name: "web-package", pattern: /@vibeflow-tools\/web(?!-)/ },
  { name: "online-product", pattern: /\bonline[-\s]?(kanban|board|mode)\b/i },
  { name: "cloud-sync", pattern: /\bcloud sync\b/i },
  { name: "billing", pattern: /\bbilling\b/i },
  { name: "trpc", pattern: /\btrpc\b/i },
  { name: "supabase", pattern: /\bsupabase\b/i },
  { name: "internal-id", pattern: /\b[0-9a-f]{30,}\b/ },
  {
    name: "local-filesystem-path",
    pattern: /(\/home\/|\/root\/|\/Users\/|\/tmp\/|[A-Z]:\\)/,
  },
];

/**
 * Scans one changeset file's full text (frontmatter + body) and returns
 * every banned-content hit. Empty array = customer-facing clean.
 */
export function scanChangesetText(text: string): ChangesetViolation[] {
  const violations: ChangesetViolation[] = [];
  for (const rule of CHANGESET_BANNED_RULES) {
    // Fresh RegExp per rule application: patterns are global-flag-free so
    // .exec is stateless, but re-running keeps this robust to edits.
    const match = new RegExp(rule.pattern.source, rule.pattern.flags).exec(
      text,
    );
    if (match) {
      violations.push({ rule: rule.name, match: match[0] });
    }
  }
  return violations;
}

/**
 * Walks up from baseDir looking for a directory containing `.changeset`.
 * Returns the repo root, or null when none is found (never throws).
 */
export function findRepoRootWithChangeset(
  baseDir: string = MODULE_DIR,
): string | null {
  try {
    let dir = baseDir;
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, ".changeset"))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        return null;
      }
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reads every pending changeset (`*.md` except README.md) under the repo
 * root's `.changeset/`. Returns an empty array when the directory is
 * missing or holds no entries (e.g. right after a release consumes them).
 */
export function listPendingChangesets(
  repoRoot: string,
): { file: string; text: string }[] {
  try {
    const dir = join(repoRoot, ".changeset");
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .sort()
      .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));
  } catch {
    return [];
  }
}

/**
 * Scans all pending changesets; returns per-file violations for files that
 * have at least one hit. Empty array = every pending entry is clean.
 */
export function scanPendingChangesets(
  repoRoot: string,
): { file: string; violations: ChangesetViolation[] }[] {
  const failures: { file: string; violations: ChangesetViolation[] }[] = [];
  for (const { file, text } of listPendingChangesets(repoRoot)) {
    const violations = scanChangesetText(text);
    if (violations.length > 0) {
      failures.push({ file, violations });
    }
  }
  return failures;
}
