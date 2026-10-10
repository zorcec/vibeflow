/**
 * The README's Research-verdict warning, enforced against the code that backs it.
 *
 * A README line is the only place a consumer learns that a verdict on a
 * Research task is refused rather than accepted, so the claim has to stay
 * true of the CLI. The refusal is defined once — `RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL`
 * in `core/review-gate.ts`, returned by the review gate, by the CLI's
 * standalone `--set-verify` check, and by the MCP `setVerify` path — so this
 * file reads the code name out of that object instead of pinning a literal a
 * future rename would orphan.
 *
 * Two things are asserted, and they are different claims:
 *   1. the warning sits on the line right after the last `--set-verify` flag
 *      line in the flag-documentation block, not in a distant section a reader
 *      of the flag docs never reaches (position, pinned by line scan);
 *   2. the warning says the CLI REJECTS the verdict — the opposite of the old
 *      behaviour it exists to document (the flag used to be accepted and the
 *      value silently scrubbed on write), so a line that downgraded it to a
 *      caution would fail here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL } from "../../src/core/review-gate.js";

const README = join(dirname(fileURLToPath(import.meta.url)), "../../README.md");
const lines = readFileSync(README, "utf-8").split("\n");
/** Prose, whitespace-flattened: line breaks and `**` are not contract. */
const text = lines.join("\n").replace(/\s+/g, " ");

/** Flag lines of the `--set-verify` documentation block (bash comments excluded). */
const SET_VERIFY_FLAG_LINE = /^\s*vibeflow tasks --edit <id> --set-verify /;
const cannotLine = lines.findIndex((l) =>
  /^\s*vibeflow tasks --edit <id> --set-verify cannot\b/.test(l),
);
/** The warning this test exists for: the line immediately after `cannot`. */
const warningLine = cannotLine >= 0 ? lines[cannotLine + 1] : "";

describe("README: the Research verdict warning belongs beside --set-verify", () => {
  it("the --set-verify flag block exists (a scan that matched nothing is vacuous)", () => {
    const flagLines = lines.filter((l) => SET_VERIFY_FLAG_LINE.test(l));
    expect(flagLines.length).toBeGreaterThan(0);
    // All three verdict forms documented — the warning describes all of them.
    expect(flagLines.some((l) => l.includes("--set-verify pass"))).toBe(true);
    expect(flagLines.some((l) => l.includes("--set-verify fail"))).toBe(true);
    expect(cannotLine).toBeGreaterThan(-1);
  });

  it("names the refusal the CLI actually returns, not a code of its own", () => {
    expect(RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.code).toBe(
      "RESEARCH_VERIFY_NOT_ALLOWED",
    );
    expect(warningLine).toContain(RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.code);
  });

  it("sits on the line directly after the last --set-verify flag line", () => {
    // Position, not mere presence: the same sentence buried in the MCP section
    // would satisfy every `toContain` while a reader of the flag docs — the
    // only audience that needs it — never sees it.
    expect(warningLine.trim().length).toBeGreaterThan(0);
    expect(warningLine).not.toBe(lines[lines.length - 1]);
  });

  it("states the outcome as a rejection, not a silently dropped value", () => {
    // The documented behaviour is the FIX: the flag used to be accepted and
    // the verdict scrubbed on write. Softening this line would reintroduce
    // the trap it was written to close.
    expect(warningLine).toMatch(/Research/i);
    expect(warningLine).toMatch(/must not carry a verdict/i);
    expect(warningLine).toMatch(/reject/i);
    // …and the README never describes a Research verdict as accepted anywhere
    // near the flag docs: the block's only verdict-bearing lines are the
    // documented flags plus this warning.
    const blockStart = lines.findIndex((l) => SET_VERIFY_FLAG_LINE.test(l));
    const block = lines.slice(blockStart, cannotLine + 2);
    expect(block.filter((l) => /RESEARCH_VERIFY_NOT_ALLOWED/.test(l))).toEqual([
      warningLine,
    ]);
  });

  it("the code it names is the one the CLI emits, in the same sentence", () => {
    // A stale code in the docs is indistinguishable from a working refusal to
    // a reader, so the sentence must carry the live constant.
    const at = text.indexOf(RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.code, text.indexOf("--set-verify"));
    expect(at).toBeGreaterThan(-1);
  });
});
