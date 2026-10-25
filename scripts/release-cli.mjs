#!/usr/bin/env node
/**
 * Create (or confirm) the GitHub Release for the published CLI version.
 *
 * There is no CI (ADR-0004: every gate runs locally), so GitHub releases are
 * created locally with this script, run once after `npm publish` lands:
 *
 *   pnpm release:cli
 *
 * What it does, in order:
 *   1. Reads the version from `packages/cli/package.json`.
 *   2. Extracts the matching `## <version>` section from
 *      `packages/cli/CHANGELOG.md` and REFUSES (non-zero, naming the version)
 *      when the section is missing or empty — a release with empty notes is a
 *      release nobody can read.
 *   3. Creates the annotated tag `v<version>` (message == tag, matching
 *      v0.21.1 history) only if absent, then pushes it. Never force-pushes.
 *   4. Creates the GitHub release `v<version>` with the extracted notes via
 *      `gh release create --notes-file`. Fails loudly when `gh` is missing or
 *      not authenticated (run `gh auth login` first).
 *
 * Idempotent: on an already-released version it prints "already released" and
 * exits 0, because the common human error here is running it twice.
 *
 * Test override (no side effects before the changelog check — a missing
 * section still fails first): `node scripts/release-cli.mjs --version 9.9.9`
 *
 * Preview the notes without touching git or GitHub:
 * `node scripts/release-cli.mjs --print-notes [--version <x.y.z>]`
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_REPO = "zorcec/vibeflow";

export function repoRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function readCliVersion(root = repoRoot()) {
  const manifest = JSON.parse(
    readFileSync(join(root, "packages/cli/package.json"), "utf8"),
  );
  return manifest.version;
}

/**
 * Return the `## <version>` CHANGELOG section, heading included. Throws an
 * Error naming the version when the section is missing or empty.
 */
export function extractReleaseNotes(changelogText, version) {
  const heading = `## ${version}`;
  const lines = changelogText.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    throw new Error(
      `release-cli: no CHANGELOG section for version ${version} (expected a "${heading}" heading in packages/cli/CHANGELOG.md)`,
    );
  }
  let end = start + 1;
  while (end < lines.length && !/^## \S/.test(lines[end])) end += 1;
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  if (!body) {
    throw new Error(
      `release-cli: CHANGELOG section for version ${version} is empty — refusing to publish unreadable release notes`,
    );
  }
  return `${lines.slice(start, end).join("\n").trim()}\n`;
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function tagExists(root, tag) {
  try {
    sh("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], root);
    return true;
  } catch {
    return false;
  }
}

function ghAuthenticated() {
  try {
    sh("gh", ["auth", "status"], undefined);
    return true;
  } catch {
    return false;
  }
}

function releaseExists(tag) {
  try {
    sh("gh", ["release", "view", tag, "--repo", RELEASE_REPO], undefined);
    return true;
  } catch {
    return false;
  }
}

function releaseUrl(tag) {
  return `https://github.com/${RELEASE_REPO}/releases/tag/${tag}`;
}

export function main(argv = process.argv.slice(2)) {
  let versionOverride = null;
  let printNotes = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--version" && i + 1 < argv.length) {
      versionOverride = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--print-notes") {
      printNotes = true;
    } else {
      console.error(
        `release-cli: unknown argument: ${argv[i]}\nusage: node scripts/release-cli.mjs [--version <x.y.z>] [--print-notes]`,
      );
      process.exit(2);
    }
  }

  const root = repoRoot();
  const version = versionOverride ?? readCliVersion(root);
  const tag = `v${version}`;

  let notes;
  try {
    notes = extractReleaseNotes(
      readFileSync(join(root, "packages/cli/CHANGELOG.md"), "utf8"),
      version,
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (printNotes) {
    process.stdout.write(notes);
    return;
  }

  if (!ghAuthenticated()) {
    console.error(
      "release-cli: gh is not authenticated — run 'gh auth login' first, then re-run this script.",
    );
    process.exit(1);
  }

  // Idempotency first: pushing the tag re-runs the repo's pre-push gate, so an
  // already-released version must exit here instead of pushing again. A release
  // existing on GitHub implies its remote tag exists (`gh release create`
  // creates one), so there is nothing left to do.
  if (releaseExists(tag)) {
    console.log(`release-cli: ${tag} already released (${releaseUrl(tag)}) — nothing to do.`);
    return;
  }

  if (tagExists(root, tag)) {
    console.log(`release-cli: tag ${tag} already exists — leaving it in place.`);
  } else {
    console.log(`release-cli: creating annotated tag ${tag} ...`);
    try {
      sh("git", ["tag", "-a", tag, "-m", tag], root);
    } catch (err) {
      console.error(`release-cli: failed to create tag ${tag}: ${err.message}`);
      process.exit(1);
    }
  }

  try {
    sh("git", ["push", "origin", tag], root);
    console.log(`release-cli: pushed tag ${tag}.`);
  } catch (err) {
    console.error(
      `release-cli: failed to push tag ${tag} (no force-push attempted): ${err.message}`,
    );
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), "release-cli-"));
  const notesFile = join(dir, "notes.md");
  writeFileSync(notesFile, notes);
  try {
    sh(
      "gh",
      ["release", "create", tag, "--repo", RELEASE_REPO, "--title", tag, "--notes-file", notesFile],
      undefined,
    );
  } catch (err) {
    console.error(`release-cli: 'gh release create ${tag}' failed: ${err.message}`);
    console.error(
      `release-cli: retry manually: gh release create "${tag}" --repo ${RELEASE_REPO} --title "${tag}" --notes-file <notes-file>`,
    );
    process.exit(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`release-cli: GitHub Release ${tag} created: ${releaseUrl(tag)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
