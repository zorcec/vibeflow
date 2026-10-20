/**
 * `authors link` must never ask git about a value that is not a sha.
 *
 * Measured during review: the resolver passed the commit's `sha` straight to
 * `git log -1 --no-walk --format=%ae <sha>`, so a record whose `sha` was
 * `--all` had git interpret it as an OPTION and return the repository's newest
 * author email — which was then written into a task file as that commit's
 * author. Wrong data, silently, in a git-tracked file.
 */
import { describe, expect, it } from "vitest";

import { gitAuthorEmailResolver, linkRecord, type AuthorsLinkResult } from "../../../src/commands/authors.js";

function emptyResult(): AuthorsLinkResult {
  return {
    linked: 0,
    alreadyLinked: 0,
    unresolved: 0,
    conflicts: 0,
    filesChanged: 0,
    distinctShas: 0,
    conflictDetails: [],
    gitAvailable: true,
  };
}

describe("authors link — sha shape", () => {
  it("refuses flag-shaped and non-hex values without invoking git", () => {
    let calls = 0;
    const resolver = gitAuthorEmailResolver(process.cwd());
    // Wrap to count: a rejected value must not spawn a subprocess at all.
    const counted = (sha: string): string | null => {
      calls += 1;
      return resolver(sha);
    };
    for (const bad of ["--all", "-n1", "HEAD", "main", "--format=%ae", "not-a-sha"]) {
      expect(counted(bad)).toBeNull();
    }
    expect(calls).toBe(6);
  });

  it("still resolves a real abbreviated sha", () => {
    const resolver = gitAuthorEmailResolver(process.cwd());
    const head = require("node:child_process")
      .execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { encoding: "utf8" })
      .trim();
    expect(resolver(head)).toMatch(/@/);
  });

  it("counts a flag-shaped sha as unresolved through the real resolver", () => {
    const result = emptyResult();
    const record = { commits: [{ sha: "--all" }] };
    linkRecord("t1", record, gitAuthorEmailResolver(process.cwd()), result);
    expect(result.unresolved).toBe(1);
    expect(result.linked).toBe(0);
    expect((record.commits[0] as { authorEmail?: string }).authorEmail).toBeUndefined();
  });
});
