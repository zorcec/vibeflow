#!/usr/bin/env node
/**
 * ADR reference guard — the pre-commit gate for docs/decisions.
 *
 * Adapted from the private repo's scripts/check-adrs.mjs for the public
 * CLI repo. ADR-0004: there is no remote CI, so this fast (~1s),
 * dependency-free script is the local gate — a push is only as safe as
 * the hooks we run locally.
 *
 * Rules (each one exists because its failure is silent otherwise):
 *   (a) every `ADR-NNNN` reference in code resolves to a decisions file — a
 *       pointer to a deleted ADR sends the next agent nowhere;
 *   (b) every ACCEPTED ADR declares `Pins:` and each pinned path exists — an
 *       ADR with no pin is a preference, not a decision;
 *   (c) `index.md` lists every ADR file and has no phantom rows;
 *   (d) every ADR file is referenced from at least one source file — a decision
 *       nobody can find from the code is the one that gets undone;
 *   (e) DRIFT: governed code must not change after the ADR was last reviewed.
 *       Compared by DAY, per file. Deliberately coarse — per-line precision is
 *       what the Pins tests provide; this only asks "did someone touch governed
 *       code without revisiting the decision?". Fix by reading the ADR and
 *       bumping `Reviewed:`, or by updating/superseding the decision.
 *
 * Refs resolve against this repo's docs/decisions/ ONLY — the public repo
 * must stand alone on a contributor's clone, so a pointer that needs the
 * private repo to resolve is a pointer that dangles. (That is why the old
 * private-0007 pointer in scripts/release-cli.mjs now reads ADR-0004.)
 *
 * Exit 1 with a list of problems. Exit 0 when clean.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const decisionsDir = resolve(repoRoot, "docs/decisions");
const scanRoots = [
  "packages/cli/src",
  "packages/ui/src",
  "packages/shared/src",
  "packages/api-core/src",
  "packages/prototyping/src",
  "packages/cli/scripts",
  "scripts",
].map((p) => resolve(repoRoot, p));

const ADR_REF = /\bADR-(\d{4})\b/g;
const SRC_EXT = /\.(ts|tsx|css|mjs|js|sh|bash)$/;

if (!existsSync(decisionsDir)) {
  console.log("check-adrs: no docs/decisions directory — nothing to check.");
  process.exit(0);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SRC_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/** Day (YYYY-MM-DD) of the newest commit touching any of `paths`, or null. */
function gitLastCommitDay(paths) {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%cs", "--", ...paths],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out || null;
  } catch {
    // Not a git checkout, or git unavailable: the date check is best-effort.
    return null;
  }
}

const adrFiles = readdirSync(decisionsDir).filter((f) => /^\d{4}-.*\.md$/.test(f));
const adrIdOf = (file) => file.slice(0, 4);
const adrPath = (id) => {
  const hit = adrFiles.find((f) => f.startsWith(`${id}-`));
  return hit ? resolve(decisionsDir, hit) : null;
};

const problems = [];
const referenced = new Set();

for (const file of scanRoots.flatMap((root) => walk(root))) {
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(ADR_REF)) {
    referenced.add(m[1]);
    if (!adrPath(m[1])) {
      problems.push(`(a) dangling reference: ${file.replace(repoRoot + "/", "")} -> ADR-${m[1]}`);
    }
  }
}

for (const f of adrFiles) {
  const body = readFileSync(resolve(decisionsDir, f), "utf8");
  // Accept both `- Status: accepted` and `- **Status:** accepted`. A regex
  // that only matches the bold form silently skips every rule below it —
  // which is exactly how a guard stops guarding.
  const status = body.match(/^[\s-]*(?:\*\*)?Status:(?:\*\*)?\s*(\S+)/m)?.[1];
  if (status !== "accepted") continue;

  const pins = [...body.matchAll(/^[-\s]*Pins:\s*`([^`]+)`/gm)].map((m) => m[1]);
  if (pins.length === 0) {
    problems.push(`(b) ${f}: accepted but declares no Pins:`);
  } else {
    for (const pin of pins) {
      if (!existsSync(resolve(repoRoot, pin))) problems.push(`(b) ${f}: pin does not exist: ${pin}`);
    }
  }

  const governed = [...body.matchAll(/^[-\s]*Governed:\s*`([^`]+)`/gm)].map((m) => m[1]);
  const reviewed = body.match(/^[-\s]*Reviewed:\s*(\d{4}-\d{2}-\d{2})/m)?.[1];
  if (governed.length === 0) {
    problems.push(`(e) ${f}: accepted but declares no Governed: paths`);
  } else if (!reviewed) {
    problems.push(`(e) ${f}: accepted but declares no Reviewed: date`);
  } else {
    const existing = governed.filter((g) => existsSync(resolve(repoRoot, g)));
    if (existing.length === 0) {
      problems.push(`(e) ${f}: none of the Governed: paths exist on disk`);
    } else {
      const lastDay = gitLastCommitDay(existing);
      if (lastDay && lastDay > reviewed) {
        problems.push(
          `(e) ${f}: governed code changed on ${lastDay}, ADR last reviewed ${reviewed} — ` +
            `read it again, update the decision, or bump Reviewed:`,
        );
      }
    }
  }
}

const index = readFileSync(resolve(decisionsDir, "index.md"), "utf8");
for (const f of adrFiles) {
  if (!index.includes(adrIdOf(f))) problems.push(`(c) ${f}: no row in index.md`);
}
for (const m of index.matchAll(/\[(\d{4})\]\((\d{4}-[^)]+)\)/g)) {
  if (!existsSync(resolve(decisionsDir, m[2]))) {
    problems.push(`(c) index.md: phantom row ADR-${m[1]} -> ${m[2]}`);
  }
}

for (const f of adrFiles) {
  const id = adrIdOf(f);
  if (!referenced.has(id)) {
    problems.push(`(d) ADR-${id} has no code reference — add a one-line pointer where it governs`);
  }
}

if (problems.length > 0) {
  console.error("✗ ADR check failed:\n" + problems.map((p) => `  ${p}`).join("\n"));
  console.error("\nFix the pointers/ADRs, or update the decision with a new ADR that supersedes it.");
  process.exit(1);
}
console.log(`✓ ADR check: ${adrFiles.length} decisions, all referenced, pins, index and drift in sync.`);
