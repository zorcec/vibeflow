/**
 * No GitHub Actions, ever (ticket cusivd86k).
 *
 * The owner's rule is not "we do not currently use Actions" — it is "they
 * should never be used". A rule that lives only in a ticket is one refactor
 * away from being re-added by someone who thinks a workflow is the tidy place
 * for a check, so it lives here and fails the unit suite instead.
 *
 * The gate this repo actually has is the local pre-push hook (ADR-0004: no
 * remote CI) plus `scripts/gate-ui.mjs` for the slow design-system checks —
 * the contrast ratchet that used to be `.github/workflows/a11y.yml` now runs
 * there.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/cli/tests/unit` → the repository root. */
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

describe("no GitHub Actions", () => {
  it("has no workflow files", () => {
    const workflows = join(REPO_ROOT, ".github", "workflows");
    const files = existsSync(workflows)
      ? readdirSync(workflows).filter((f) => /\.ya?ml$/i.test(f))
      : [];
    expect(
      files,
      "GitHub Actions are not used in this repo (ticket cusivd86k). Put the check in .husky/pre-push, scripts/affected-suites.mjs or scripts/gate-ui.mjs instead.",
    ).toEqual([]);
  });

  it("has no local composite actions", () => {
    // `.github/actions/<name>/action.yml` is the other half of the feature:
    // a reusable action with no workflow is still Actions machinery.
    expect(existsSync(join(REPO_ROOT, ".github", "actions"))).toBe(false);
  });
});
