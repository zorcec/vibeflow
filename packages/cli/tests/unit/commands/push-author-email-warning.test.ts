/**
 * The push warning must name a gap the user can actually close.
 *
 * It said "N task(s) have commits missing authorEmail — run `vibeflow authors
 * link`", but `authors link` resolves a commit by its sha through git history.
 * An entry with an EMPTY sha is unlinkable: the command reports "0 unresolved"
 * and the warning stays forever, so the only visible advice is advice that does
 * not work. One real task is in that state ("CLI task retrieve improvement").
 *
 * The unlinkable entry is still a gap in the DATA — it is simply a different
 * gap, and it must not be deleted to silence a counter (deleting a commit to
 * satisfy a validator is data loss, not a fix).
 */
import { describe, expect, it } from "vitest";

import { countTasksMissingCommitAuthorEmail } from "../../../src/commands/push.js";

describe("countTasksMissingCommitAuthorEmail", () => {
  it("counts a commit that has a sha but no email — the linkable gap", () => {
    expect(
      countTasksMissingCommitAuthorEmail([
        { commits: [{ sha: "abc123" }] },
        { commits: [{ sha: "def456", authorEmail: "a@b.test" }] },
      ]),
    ).toBe(1);
  });

  it("ignores a commit with no sha: `authors link` can never resolve it", () => {
    expect(
      countTasksMissingCommitAuthorEmail([
        { commits: [{ sha: "", message: "recorded before the commit existed" }] },
        { commits: [{ message: "no sha at all" }] },
      ]),
    ).toBe(0);
  });

  it("treats a whitespace-only email as missing", () => {
    expect(
      countTasksMissingCommitAuthorEmail([{ commits: [{ sha: "abc", authorEmail: "   " }] }]),
    ).toBe(1);
  });

  it("counts a task once, however many of its commits are missing", () => {
    expect(
      countTasksMissingCommitAuthorEmail([
        { commits: [{ sha: "a" }, { sha: "b" }, { sha: "c" }] },
      ]),
    ).toBe(1);
  });

  it("counts nothing when there are no commits or no tasks", () => {
    expect(countTasksMissingCommitAuthorEmail([])).toBe(0);
    expect(countTasksMissingCommitAuthorEmail([{}, { commits: [] }])).toBe(0);
  });
});
