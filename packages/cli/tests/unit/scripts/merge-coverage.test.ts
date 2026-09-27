/**
 * The merge must not be able to report a number it cannot stand behind.
 *
 * `scripts/merge-coverage.mjs` joins the unit and e2e coverage of
 * `src/index.ts`. A join of ONE side still runs: every line of the merge is
 * arithmetic over "whatever maps arrived", so a missing e2e side produced a
 * "merged" number that was really the unit-only number — the same dishonesty
 * the tooling was added to remove, wearing a "merged" column heading.
 *
 * So the checks live in `scripts/merge-coverage-guards.mjs` (importable; the
 * merge script does all its work at import time) and are exercised here with
 * deliberately incomplete pairs, plus one end-to-end spawn that proves the
 * script itself exits non-zero rather than printing a number.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  assertMergeIsHonest,
  describeOneSidedFiles,
} from "../../../scripts/merge-coverage-guards.mjs";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SUBJECT = "src/index.ts";
const CLI = resolve(import.meta.dirname, "../../..");

/** An istanbul file entry with `covered` of `total` statements hit. */
function istanbulEntry(covered: number, total = 2, path = SUBJECT) {
  const entry = {
    path,
    statementMap: {},
    s: {},
    fnMap: {},
    f: {},
    branchMap: {},
    b: {},
  };
  for (let i = 0; i < total; i++) {
    entry.statementMap[i] = {
      start: { line: i + 1, column: 0 },
      end: { line: i + 1, column: 1 },
    };
    entry.s[i] = i < covered ? 1 : 0;
  }
  return entry;
}

/** A complete, honest pair — the baseline every refusal case mutates. */
function completeFacts() {
  return {
    subject: SUBJECT,
    rawE2eFiles: 7,
    executedBundleFiles: 2,
    remappedFiles: [`/repo/${SUBJECT}`],
    unitFiles: [`/repo/${SUBJECT}`],
    e2eFiles: [`/repo/${SUBJECT}`],
    unitKey: `/repo/${SUBJECT}`,
    e2eKey: `/repo/${SUBJECT}`,
    e2eEntry: istanbulEntry(1),
  };
}

describe("merge-coverage guards — an incomplete pair is a refusal, not a number", () => {
  it("accepts a complete pair", () => {
    expect(() => assertMergeIsHonest(completeFacts())).not.toThrow();
  });

  it("refuses when the e2e pass produced no coverage file at all", () => {
    expect(() =>
      assertMergeIsHonest({ ...completeFacts(), rawE2eFiles: 0 }),
    ).toThrow(/e2e coverage dir held no \*\.json file/);
  });

  it("refuses when nothing the e2e children ran belongs to the coverage build", () => {
    expect(() =>
      assertMergeIsHonest({ ...completeFacts(), executedBundleFiles: 0 }),
    ).toThrow(/executed anything from the coverage build/);
  });

  it("refuses when the e2e pass remapped to no source file", () => {
    expect(() =>
      assertMergeIsHonest({ ...completeFacts(), remappedFiles: [] }),
    ).toThrow(/remapped to no src\/\*\* file/);
  });

  it("refuses when the subject is missing from the e2e map — a unit-only merge", () => {
    expect(() =>
      assertMergeIsHonest({
        ...completeFacts(),
        e2eFiles: ["/repo/src/other.ts"],
        e2eKey: undefined,
        e2eEntry: undefined,
      }),
    ).toThrow(/is in the unit map but not in the e2e map/);
  });

  it("names the same-named file when the e2e side spelled the path differently", () => {
    // A path-spelling mismatch (a different checkout root) is the version of
    // this bug that looks like "the e2e suite simply did not run". Naming the
    // near miss is the difference between a 5-minute fix and an afternoon.
    expect(() =>
      assertMergeIsHonest({
        ...completeFacts(),
        e2eFiles: ["/elsewhere/packages/ui/src/index.ts"],
        e2eKey: undefined,
        e2eEntry: undefined,
      }),
    ).toThrow(/\/elsewhere\/packages\/ui\/src\/index\.ts/);
  });

  it("refuses when the subject is missing from the unit map", () => {
    expect(() =>
      assertMergeIsHonest({
        ...completeFacts(),
        unitFiles: ["/repo/src/other.ts"],
        unitKey: undefined,
      }),
    ).toThrow(/is in the e2e map but not in the unit map/);
  });

  it("refuses when NEITHER pass produced the subject", () => {
    expect(() =>
      assertMergeIsHonest({
        ...completeFacts(),
        unitFiles: ["/repo/src/other.ts"],
        e2eFiles: ["/repo/src/other.ts"],
        unitKey: undefined,
        e2eKey: undefined,
        e2eEntry: undefined,
      }),
    ).toThrow(/neither coverage pass produced an entry/);
  });

  it("refuses when the e2e side covers nothing in the file it exists to measure", () => {
    expect(() =>
      assertMergeIsHonest({ ...completeFacts(), e2eEntry: istanbulEntry(0) }),
    ).toThrow(/ZERO covered statements/);
  });

  it("counts the one-sided files instead of pretending they are all merged", () => {
    expect(
      describeOneSidedFiles(["/a.ts", "/shared.ts"], ["/b.ts", "/shared.ts"]),
    ).toBe("1 file(s) measured by the unit pass only, 1 by the e2e pass only");
  });
});

describe("merge-coverage.mjs refuses an incomplete pair end to end", () => {
  /** Runs the real script over fixture inputs; returns its exit code + output. */
  function runMerge(unitMap: unknown, e2eFiles: string[]) {
    const dir = freshDir("merge-coverage-guard-");
    const unitPath = join(dir, "unit-coverage-final.json");
    writeFileSync(unitPath, JSON.stringify(unitMap), "utf-8");
    const e2eDir = join(dir, "e2e");
    mkdirSync(e2eDir, { recursive: true });
    for (const [name, body] of Object.entries(e2eFiles)) {
      writeFileSync(join(e2eDir, `${name}.json`), body, "utf-8");
    }
    try {
      const stdout = execFileSync(
        "node",
        [
          join(CLI, "scripts", "merge-coverage.mjs"),
          "--unit",
          unitPath,
          "--e2e",
          e2eDir,
          "--cli-dir",
          join(dir, "no-such-build"),
          "--out",
          join(dir, "out"),
        ],
        { cwd: CLI, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { code: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("exits non-zero instead of printing a merged number when the e2e side is empty", () => {
    // A unit map for the subject, and an e2e dir holding exactly one file that
    // executed nothing from the coverage build: the shape of an e2e run that
    // silently produced no usable counters. The old script merged this happily
    // and printed the unit number under a "merged" heading.
    const subjectPath = "/repo/src/index.ts";
    const result = runMerge(
      { [subjectPath]: istanbulEntry(1, 2, subjectPath) },
      { "coverage-1": JSON.stringify({ result: [] }) },
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "merge-coverage: refusing to report a merged number",
    );
    expect(result.stdout).not.toContain("merged");
  }, 60_000);
});
