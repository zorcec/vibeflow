/**
 * `vibeflow authors link` + the lossless wire record.
 *
 * The rules being pinned here are the ones that keep attribution honest and the
 * local store untouched when it should be:
 *  - an existing, DIFFERENT email is never overwritten (it is data, not a bug);
 *  - an unresolved sha is reported, never guessed;
 *  - `--dry-run` writes nothing;
 *  - a second run changes nothing;
 *  - bytes outside the inserted key are preserved so the git diff is reviewable;
 *  - runtime-only keys (absolute filePath, captured auth state) never travel.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  authorsLink,
  linkRecord,
  formatAuthorsLinkResult,
  type AuthorsLinkResult,
} from "../../../src/commands/authors.js";
import { recordForWire } from "../../../src/saas/batch-push.js";

function emptyResult(): AuthorsLinkResult {
  return {
    linked: 0,
    alreadyLinked: 0,
    unresolved: 0,
    conflicts: 0,
    conflictDetails: [],
    filesChanged: 0,
    distinctShas: 0,
    gitAvailable: true,
  };
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-authors-"));
  mkdirSync(join(dir, ".vibeflow", "tasks", "2026-01-01"), { recursive: true });
  return dir;
}

function writeTask(projectDir: string, record: Record<string, unknown>): string {
  const path = join(projectDir, ".vibeflow", "tasks", "2026-01-01", `${record.id}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

describe("linkRecord", () => {
  it("adds the resolved author email to a commit that has none", () => {
    const result = emptyResult();
    const record = { commits: [{ sha: "aaa", message: "m", timestamp: "t" }] };
    const changed = linkRecord("t1", record, (sha) => (sha === "aaa" ? "a@b.co" : null), result);
    expect(changed).toBe(true);
    expect((record.commits[0] as { authorEmail?: string }).authorEmail).toBe("a@b.co");
    expect(result.linked).toBe(1);
  });

  it("counts an existing equal value as already linked and leaves it alone", () => {
    const result = emptyResult();
    const record = { commits: [{ sha: "aaa", authorEmail: "a@b.co" }] };
    const changed = linkRecord("t1", record, () => "a@b.co", result);
    expect(changed).toBe(false);
    expect(result.alreadyLinked).toBe(1);
    expect(result.linked).toBe(0);
  });

  it("never overwrites a different recorded email — it reports a conflict", () => {
    const result = emptyResult();
    const record = { commits: [{ sha: "aaa", authorEmail: "old@b.co" }] };
    const changed = linkRecord("t1", record, () => "new@b.co", result);
    expect(changed).toBe(false);
    expect((record.commits[0] as { authorEmail?: string }).authorEmail).toBe("old@b.co");
    expect(result.conflicts).toBe(1);
    expect(result.conflictDetails).toEqual([
      { taskId: "t1", sha: "aaa", existing: "old@b.co", resolved: "new@b.co" },
    ]);
  });

  it("reports an unresolvable sha instead of guessing", () => {
    const result = emptyResult();
    const record = { commits: [{ sha: "gone" }] };
    const changed = linkRecord("t1", record, () => null, result);
    expect(changed).toBe(false);
    expect(result.unresolved).toBe(1);
    expect((record.commits[0] as { authorEmail?: string }).authorEmail).toBeUndefined();
  });

  it("ignores a resolved value that is not a valid email", () => {
    const result = emptyResult();
    const record = { commits: [{ sha: "aaa" }] };
    linkRecord("t1", record, () => "not-an-email", result);
    expect(result.unresolved).toBe(1);
    expect(result.linked).toBe(0);
  });
});

describe("authorsLink", () => {
  const baseRecord = {
    id: "t1",
    title: "T",
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    sortKey: "1",
    comments: [],
    files: [],
    links: [],
  };

  it("writes the email, keeps every other byte, and is idempotent", async () => {
    const dir = makeProject();
    const before = JSON.stringify(
      { ...baseRecord, commits: [{ sha: "aaa", message: "m", timestamp: "2026-01-01T00:00:00.000Z" }] },
      null,
      2,
    ) + "\n";
    const path = join(dir, ".vibeflow", "tasks", "2026-01-01", "t1.json");
    writeFileSync(path, before, "utf8");

    const first = await authorsLink(dir, { resolveEmail: () => "a@b.co" });
    expect(first.linked).toBe(1);
    expect(first.filesChanged).toBe(1);

    const after = readFileSync(path, "utf8");
    // Byte-exact expectation: 2-space JSON, trailing newline, every original
    // key untouched — the git diff is exactly one added line.
    const expected =
      JSON.stringify(
        {
          ...baseRecord,
          commits: [
            { sha: "aaa", message: "m", timestamp: "2026-01-01T00:00:00.000Z", authorEmail: "a@b.co" },
          ],
        },
        null,
        2,
      ) + "\n";
    expect(after).toBe(expected);
    expect(after).toContain('"authorEmail": "a@b.co"');

    const second = await authorsLink(dir, { resolveEmail: () => "a@b.co" });
    expect(second.linked).toBe(0);
    expect(second.alreadyLinked).toBe(1);
    expect(second.filesChanged).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  it("dry run writes nothing", async () => {
    const dir = makeProject();
    const path = writeTask(dir, {
      ...baseRecord,
      commits: [{ sha: "aaa", message: "m", timestamp: "t" }],
    });
    const before = readFileSync(path, "utf8");
    const result = await authorsLink(dir, { dryRun: true, resolveEmail: () => "a@b.co" });
    expect(result.linked).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("reports the distinct sha count actually resolved", async () => {
    const dir = makeProject();
    writeTask(dir, { ...baseRecord, id: "t1", commits: [{ sha: "a" }, { sha: "b" }, { sha: "a" }] });
    const result = await authorsLink(dir, { dryRun: true, resolveEmail: (s) => `${s}@x.co` });
    expect(result.distinctShas).toBe(2);
    expect(result.linked).toBe(3);
  });

  it("refuses before writing when git is unavailable (not a repository)", async () => {
    const dir = makeProject();
    const path = writeTask(dir, {
      ...baseRecord,
      commits: [{ sha: "aaa", message: "m", timestamp: "t" }],
    });
    const before = readFileSync(path, "utf8");
    // No injected resolver → the command prechecks git itself. A half-written
    // store is worse than an honest refusal, so it must write nothing.
    const result = await authorsLink(dir, {});
    expect(result.gitAvailable).toBe(false);
    expect(result.filesChanged).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("formats a readable summary", () => {
    const out = formatAuthorsLinkResult(
      { ...emptyResult(), linked: 3, filesChanged: 2, distinctShas: 2 },
      false,
    );
    expect(out).toContain("Linked 3 commit author email(s)");
    expect(out).toContain("git-tracked");
  });
});

describe("recordForWire", () => {
  it("drops runtime-only keys and the captured credential, recursively", () => {
    const out = recordForWire({
      id: "t1",
      title: "T",
      filePath: "/home/someone/secret/task.json",
      authStateEnc: "SECRET",
      capture: { authStateEnc: "SECRET2", keep: 1 },
    });
    expect(out.filePath).toBeUndefined();
    expect(out.authStateEnc).toBeUndefined();
    expect((out.capture as Record<string, unknown>).authStateEnc).toBeUndefined();
    expect((out.capture as Record<string, unknown>).keep).toBe(1);
    // Unknown future keys survive: that is what tasks.raw protects.
    expect(out.title).toBe("T");
  });
});
