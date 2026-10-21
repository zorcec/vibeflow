import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  applyEmails,
  missingAuthorEmails,
  resolveEmailsForRecords,
  resolveEmailsFromGit,
} from "../../../src/saas/commit-emails";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("missingAuthorEmails", () => {
  it("lists only commits that carry a sha but no email", () => {
    const record = {
      commits: [
        { sha: SHA, authorEmail: "a@b.test" },
        { sha: "fedcba9876543210fedcba9876543210fedcba98" },
        { sha: "" },
        "not-an-object",
      ],
    };
    expect(missingAuthorEmails(record)).toEqual([
      "fedcba9876543210fedcba9876543210fedcba98",
    ]);
  });

  it("returns nothing for a record without commits", () => {
    expect(missingAuthorEmails({ id: "t1" })).toEqual([]);
    expect(missingAuthorEmails({ commits: "nope" })).toEqual([]);
  });

  it("ignores a sha-shaped value that is not a hex object name", () => {
    expect(missingAuthorEmails({ commits: [{ sha: "--upload-pack=evil" }] })).toEqual([]);
  });
});

describe("applyEmails", () => {
  it("fills the email and leaves everything else untouched", () => {
    const record = { id: "t1", commits: [{ sha: SHA }, { sha: "other", authorEmail: "kept@x" }] };
    const out = applyEmails(record, new Map([[SHA, "resolved@x"]]));
    expect(out).toEqual({
      id: "t1",
      commits: [{ sha: SHA, authorEmail: "resolved@x" }, { sha: "other", authorEmail: "kept@x" }],
    });
  });

  it("never overwrites a recorded email", () => {
    const record = { commits: [{ sha: SHA, authorEmail: "recorded@x" }] };
    const out = applyEmails(record, new Map([[SHA, "git@x"]]));
    expect((out.commits as Array<{ authorEmail: string }>)[0]!.authorEmail).toBe("recorded@x");
  });

  it("returns the SAME object when nothing changes (so hashing cannot drift)", () => {
    const record = { commits: [{ sha: SHA, authorEmail: "a@b" }] };
    expect(applyEmails(record, new Map([[SHA, "a@b"]]))).toBe(record);
    expect(applyEmails(record, new Map())).toBe(record);
  });
});

describe("resolveEmailsFromGit (real repository)", () => {
  const cwd = process.cwd().replace(/\/packages\/cli.*$/, "");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const expected = execFileSync("git", ["log", "-1", "--format=%ae", head], {
    cwd,
    encoding: "utf8",
  }).trim();

  it("resolves a real commit to its author email", () => {
    const map = resolveEmailsFromGit([head], cwd);
    expect(map.get(head)).toBe(expected);
  });

  it("resolves every missing email for a batch of records in one pass", () => {
    const map = resolveEmailsForRecords([{ commits: [{ sha: head }] }], cwd);
    expect(map.get(head)).toBe(expected);
  });

  it("misses silently for an unknown sha instead of throwing", () => {
    const unknown = "0".repeat(40);
    const map = resolveEmailsFromGit([unknown], cwd);
    expect(map.has(unknown)).toBe(false);
  });

  it("misses silently when the directory is not a repository", () => {
    expect(resolveEmailsFromGit([head], "/tmp").size).toBe(0);
  });
});
