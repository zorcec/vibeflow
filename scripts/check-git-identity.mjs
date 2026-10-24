#!/usr/bin/env node
/** Commit-time identity policy plus history/push backstops. No environment opt-out. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Permanent owner-approved exceptions from the diagnostic identity incident; never add new ones.
export const GRANDFATHERED_COMMITS = Object.freeze([
  "ba2e776e822553ec39fa9e3174adbe6b6d06c070", // Diagnostic identity incident: init.
  "0ad21807b36335cbaa03dcd3c4ee2abdf5b00aa9", // Diagnostic identity incident: init.
  "5d1f4f2307cddeb4b1bc694e30f0695b01c8db7b", // Diagnostic identity incident: init.
  "5c3ba95458bb5c1076466b768af7d7f85bed4e92", // Diagnostic identity incident: valid fix, wrong identity.
  "bdde3c39a05ff15d1b581def867beda0798f9704", // Diagnostic identity incident: valid fix, wrong identity.
]);

export function isTestIdentity(name, email) {
  return /^(p5|test)$/i.test(name.trim()) ||
    /(@test\.local$|@example\.com$|^p5@|^test@localhost$)/i.test(email.trim());
}

function git(args, cwd, input) {
  return execFileSync("git", args, { cwd, input, encoding: "utf8", stdio: "pipe" }).trim();
}

export function collectCommits(args, cwd = process.cwd()) {
  const hashes = git(["rev-list", ...args], cwd);
  if (!hashes) return [];
  return git([
    "log", "--no-walk", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce", "--stdin",
  ], cwd, `${hashes}\n`).split("\n").map((line) => {
    const [sha, authorName, authorEmail, committerName, committerEmail] = line.split("\0");
    return { sha, authorName, authorEmail, committerName, committerEmail };
  });
}

// Both history and push scans filter individual offenders through this exact predicate.
export function identityViolations(commits) {
  return commits.filter((commit) =>
    isTestIdentity(commit.authorName, commit.authorEmail) ||
    isTestIdentity(commit.committerName, commit.committerEmail),
  ).filter((commit) => !GRANDFATHERED_COMMITS.includes(commit.sha));
}

export function pushCommits(input, remote = "origin", cwd = process.cwd()) {
  const commits = new Map();
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^[a-f0-9]{40}$/.test(fields[1]) || !/^[a-f0-9]{40}$/.test(fields[3])) {
      throw new Error(`invalid pre-push ref update: ${line}`);
    }
    const [, localSha, , remoteSha] = fields;
    if (/^0+$/.test(localSha)) continue; // Deleting a ref publishes no commits.
    let args;
    if (/^0+$/.test(remoteSha)) {
      args = [localSha, "--not", `--remotes=${remote}`];
    } else {
      try {
        git(["cat-file", "-e", `${remoteSha}^{commit}`], cwd);
        args = [`${remoteSha}..${localSha}`];
      } catch {
        console.error(`⚠ git identity: remote commit ${remoteSha} is unavailable; checking full local history.`);
        args = [localSha];
      }
    }
    for (const commit of collectCommits(args, cwd)) commits.set(commit.sha, commit);
  }
  return [...commits.values()];
}

function printIdentities(authorName, authorEmail, committerName, committerEmail) {
  console.error(`  Author: ${authorName} <${authorEmail}>`);
  console.error(`  Committer: ${committerName} <${committerEmail}>`);
}

function printFix() {
  console.error('  Fix: git config user.name "Your Name"');
  console.error('       git config user.email "you@your-domain.org"');
  console.error("  Also correct GIT_AUTHOR_NAME/EMAIL, GIT_COMMITTER_NAME/EMAIL or --author overrides if set.");
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    const identities = ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"].map((key) => {
      const resolved = git(["var", key]);
      const match = /^(.*) <([^<>]*)> \d+ [+-]\d+$/.exec(resolved);
      if (!match) throw new Error(`cannot parse ${key}: ${resolved}`);
      return { name: match[1], email: match[2] };
    });
    const [author, committer] = identities;
    if (identities.some(({ name, email }) => isTestIdentity(name, email))) {
      console.error("✗ git identity: refusing commit with a test identity.");
      printIdentities(author.name, author.email, committer.name, committer.email);
      printFix();
      return 1;
    }
    console.log(`✓ git identity: accepted author ${author.name} <${author.email}>; committer ${committer.name} <${committer.email}>.`);
    return 0;
  }

  let commits;
  if (argv.length === 1 && argv[0] === "--history") {
    commits = collectCommits(["-n", "50", "HEAD"]);
  } else if (argv[0] === "--pre-push" && argv.length <= 2) {
    commits = pushCommits(readFileSync(0, "utf8"), argv[1]);
  } else {
    throw new Error("usage: node scripts/check-git-identity.mjs [--history | --pre-push [remote]]");
  }
  const violations = identityViolations(commits);
  if (violations.length) {
    console.error(`✗ git identity: refusing ${violations.length} commit(s) with a test identity.`);
    for (const commit of violations) {
      console.error(`  Commit: ${commit.sha}`);
      printIdentities(commit.authorName, commit.authorEmail, commit.committerName, commit.committerEmail);
    }
    printFix();
    console.error("  Correct unpublished offending commits before pushing; do not rewrite published history.");
    return 1;
  }
  console.log("✓ git identity: no new test identities in checked commits.");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`✗ git identity: cannot verify identity: ${error.message}`);
    process.exitCode = 1;
  }
}
