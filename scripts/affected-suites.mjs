// Affected-only pre-push suite selector (child 6fc455a3, ADR-0004: no remote
// CI — the local pre-push hook is the gate, so it stays fast and selective).
//
// Derives the changed paths from the push range and returns only the suites
// those paths can break, via the explicit RULES table below. FAIL-CLOSED by
// construction: an unmapped path, a shallow/unavailable base, or a force
// push selects every suite — never none. The hook (.husky/pre-push) consults
// this module; it must never run suites unconditionally.
//
// Suites: unit (vitest run), e2e (vitest.e2e), integration
// (vitest.integration), playwright (vitest.pw / test:browser),
// ui (@vibeflow-tools/ui unit suite + story tests).
//
// Usage (review without pushing):
//   node scripts/affected-suites.mjs --dry-run --range <base>..<head>
//   node scripts/affected-suites.mjs --dry-run --paths a.ts,docs/x.md
// Hook usage:
//   <pre-push stdin> | node scripts/affected-suites.mjs --print
// Prints a space-separated suite list, or "none". Always exits 0: selection
// failure means ALL suites (fail closed), never an error the hook misreads.

import { execFileSync } from "node:child_process";

export const ALL_SUITES = ["unit", "e2e", "integration", "playwright", "ui"];
const ALL = [...ALL_SUITES];

// [pattern, suites]. First match wins. "none" paths (docs, changesets,
// skills, web sources that have no suite in THIS repo) are explicit —
// anything not matched falls through to ALL (fail closed).
const RULES = [
  // UI bundle shipped from the CLI package: exercised by the browser suite
  // on top of the CLI suites (unit guards under tests/unit/client/** run
  // in `unit`, so it stays selected).
  [/^packages\/cli\/src\/client\//, ["unit", "e2e", "integration", "playwright"]],
  // CLI sources: unit + integration + e2e (ADR-0004 pins the hook).
  [/^packages\/cli\//, ["unit", "e2e", "integration"]],
  // Root scripts with unit pins (check-git-identity, release-cli, this map).
  [/^scripts\//, ["unit"]],
  // Design-system sources: the @vibeflow-tools/ui unit suite plus the
  // story tests (test:stories) run in the pre-push `ui` lane.
  [/^packages\/ui\//, ["ui"]],
  // No suite in this repo: docs, changesets, skills, web sources (n/a here).
  [/\.md$/, []],
  [/^\.changeset\//, []],
  [/^docs\//, []],
  [/^\.opencode\/skills\//, []],
  [/^packages\/web\//, []],
];

const ZERO = "0".repeat(40);

/** Select the suites broken by `paths` (repo-root-relative). Fail-closed. */
export function selectSuitesForPaths(paths) {
  const selected = new Set();
  let sawUnknown = false;
  for (const p of paths) {
    const rule = RULES.find(([re]) => re.test(p));
    if (!rule) {
      sawUnknown = true;
      break;
    }
    for (const s of rule[1]) selected.add(s);
  }
  if (sawUnknown) return [...ALL];
  return [...ALL_SUITES].filter((s) => selected.has(s));
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

/** Changed paths for `base..head`. Throws when the base is unavailable. */
export function changedPathsForRange(cwd, base, head) {
  const out = git(["diff", "--name-only", `${base}..${head}`], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

function baseForNewBranch(cwd, remoteName) {
  const candidates = [`${remoteName}/HEAD`, `${remoteName}/main`, `${remoteName}/master`];
  for (const c of candidates) {
    try {
      git(["rev-parse", "--verify", c], cwd);
      return git(["merge-base", "HEAD", c], cwd);
    } catch {
      // try the next candidate
    }
  }
  throw new Error("no usable base for new branch");
}

/**
 * Select suites from pre-push stdin lines
 * (`<local ref> <local sha> <remote ref> <remote sha>` per line).
 * Fail-closed: empty input, unavailable base, or force push => ALL.
 */
export function selectSuitesForPushInput(cwd, remoteName, stdinText) {
  const lines = stdinText.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [...ALL];
  const allPaths = new Set();
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) return [...ALL];
    const [, localSha, , remoteSha] = parts;
    if (localSha === ZERO) continue; // branch deletion pushes no code
    try {
      if (remoteSha === ZERO) {
        const base = baseForNewBranch(cwd, remoteName);
        for (const p of changedPathsForRange(cwd, base, localSha)) allPaths.add(p);
      } else {
        // Force push (remote not an ancestor of local) => run everything.
        try {
          git(["merge-base", "--is-ancestor", remoteSha, localSha], cwd);
        } catch {
          return [...ALL];
        }
        for (const p of changedPathsForRange(cwd, remoteSha, localSha)) allPaths.add(p);
      }
    } catch {
      return [...ALL]; // shallow / unavailable base => fail closed
    }
  }
  return selectSuitesForPaths([...allPaths]);
}

function printSelection(suites) {
  process.stdout.write(suites.length === 0 ? "none\n" : `${suites.join(" ")}\n`);
}

// --- CLI -------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes("--print")) {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (stdin += c));
  process.stdin.on("end", () => {
    const remote = process.argv.includes("--remote")
      ? process.argv[process.argv.indexOf("--remote") + 1]
      : "origin";
    printSelection(selectSuitesForPushInput(process.cwd(), remote, stdin));
  });
} else if (args.includes("--dry-run")) {
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };
  let suites;
  const range = at("--range");
  const paths = at("--paths");
  if (range) {
    const [base, head] = range.split("..");
    try {
      suites = selectSuitesForPaths(changedPathsForRange(process.cwd(), base, head ?? "HEAD"));
    } catch {
      suites = [...ALL]; // unavailable base => fail closed
    }
    process.stdout.write(`range: ${range}\n`);
  } else if (paths) {
    suites = selectSuitesForPaths(paths.split(",").map((p) => p.trim()).filter(Boolean));
  } else {
    process.stderr.write("usage: affected-suites.mjs --dry-run (--range <base>..<head> | --paths a,b)\n");
    process.exit(2);
  }
  process.stdout.write(`suites: ${suites.length === 0 ? "none" : suites.join(" ")}\n`);
}
