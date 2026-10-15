import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ticket cba03995 (CLI counterpart of the private
 * packages/web/tests/unit/error-guard-coverage.test.ts) — the CLI error
 * guard (tests/playwright/error-guard.ts) must apply to EVERY Playwright
 * spec that mints browser pages, and no such spec may silently skip it.
 *
 * The invariant, over ALL specs in tests/playwright: each spec either wires
 * the guard (`guardContext`/`guardPage` from `./error-guard` plus an
 * `assertNoErrors` call), or is listed in EXEMPT_SPECS with a REASON. No
 * silent third category, no wildcard patterns — keys are exact filenames.
 */
const PW_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "playwright");

// Specs allowed to skip the guard, each WITH a reason.
const EXEMPT_SPECS: Record<string, string> = {
  "overlay-advanced.test.ts":
    "no browser page exists: node-fetch wire contract for the overlay Advanced payload (bundle smoke + POST /api/tasks), nothing renders",
};

function wiresGuard(src: string): boolean {
  return src.includes("error-guard") && src.includes("assertNoErrors");
}

describe("error-guard coverage (cba03995)", () => {
  const files = readdirSync(PW_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .sort();

  it("every spec wires the error guard, or is exempt with a reason", () => {
    const violators: string[] = [];
    for (const file of files) {
      if (EXEMPT_SPECS[file]) continue;
      const src = readFileSync(join(PW_DIR, file), "utf8");
      if (!wiresGuard(src)) violators.push(file);
    }
    expect(
      violators,
      `These specs skip the error guard ` +
        `(guardContext/guardPage + assertNoErrors from ./error-guard, ` +
        `or an exact-filename EXEMPT_SPECS entry with a reason): ${violators.join(", ")}`,
    ).toEqual([]);
  });

  it("every page minted in a guarded spec is attached", () => {
    // guardContext covers future pages; guardPage covers a single page.
    // A spec that mints pages must reference at least one of them.
    const unattached: string[] = [];
    for (const file of files) {
      if (EXEMPT_SPECS[file]) continue;
      const src = readFileSync(join(PW_DIR, file), "utf8");
      if (!src.includes("error-guard")) continue;
      const mintsPages = src.includes("newContext(") || src.includes("newPage(");
      if (!mintsPages) continue;
      if (!src.includes("guardContext(") && !src.includes("guardPage(")) {
        unattached.push(file);
      }
    }
    expect(
      unattached,
      `These specs use the guard but never attach it to their pages: ${unattached.join(", ")}`,
    ).toEqual([]);
  });

  it("exemptions are exact filenames with real reasons (no patterns, no stale entries)", () => {
    for (const [file, reason] of Object.entries(EXEMPT_SPECS)) {
      expect(
        files.includes(file),
        `exemption entry for missing spec ${file} — remove it`,
      ).toBe(true);
      expect(
        typeof reason === "string" && reason.trim().length > 0,
        `exemption entry for ${file} has no reason — every exemption needs one`,
      ).toBe(true);
      expect(
        file,
        `exemption keys must be exact filenames, never patterns: ${file}`,
      ).not.toMatch(/[*?[\]{}()|/\\]/);
    }
  });
});
