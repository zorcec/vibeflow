import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ALL_SUITES,
  selectSuitesForPaths,
} from "../../../../scripts/affected-suites.mjs";

const root = resolve(__dirname, "../../../..");
const hookSource = readFileSync(join(root, ".husky/pre-push"), "utf8");

// Gates: per-push is affected-only (child 6fc455a3). The hook must consult
// the path→suite map — it must never run every suite unconditionally.
describe("affected-only pre-push gate", () => {
  it("a docs-only changeset in the range selects zero suites", () => {
    expect(
      selectSuitesForPaths([
        "docs/guides/quickstart.md",
        "README.md",
        ".changeset/neat-pandas-jump.md",
      ]),
    ).toEqual([]);
  });

  it("a packages/cli/src change selects the cli suites", () => {
    expect(
      selectSuitesForPaths(["packages/cli/src/commands/tasks.ts"]).sort(),
    ).toEqual(["e2e", "integration", "unit"]);
  });

  it("a packages/ui/src change selects the browser suite", () => {
    expect(selectSuitesForPaths(["packages/ui/src/kanban/card.tsx"])).toEqual([
      "playwright",
    ]);
  });

  it("is FAIL-CLOSED: an unmapped path runs everything", () => {
    expect(selectSuitesForPaths(["infra/mystery-box/deploy.sh"]).sort()).toEqual(
      [...ALL_SUITES].sort(),
    );
  });

  it("mixing docs with cli src still selects the cli suites", () => {
    expect(
      selectSuitesForPaths([
        "docs/guides/quickstart.md",
        "packages/cli/src/commands/tasks.ts",
      ]).sort(),
    ).toEqual(["e2e", "integration", "unit"]);
  });

  it("the pre-push hook consults the map instead of running everything", () => {
    // Guard against silently bypassing the map: if the hook stops calling
    // the selector, affected-only silently becomes run-everything.
    expect(hookSource).toContain("affected-suites.mjs");
    // The old unconditional block ran each suite in fixed order with no
    // selection gate in between — the hook must branch on the selection.
    expect(hookSource).toMatch(/SELECTED_SUITES|selected_suites|selected suites/i);
  });
});
