import { describe, expect, it } from "vitest";

import { KANBAN_CSS_SOURCE_HASH } from "../../../src/server/kanban-css.gen";
import { kanbanCssSourceHash } from "../../../scripts/lib/kanban-css-source-hash.mjs";

/**
 * The CLI board's stylesheet is generated from the shared UI CSS and committed.
 * `prebuild` regenerates it, but nothing failed when someone edited the shared
 * CSS and committed WITHOUT a rebuild — the CLI board then served the previous
 * stylesheet while the hosted app served the new one, and every test stayed
 * green (found while reviewing the phone-width work, ticket 45a8e57c).
 *
 * The failure message names the fix, because the fix is one command.
 */
describe("generated kanban CSS is fresh (45a8e57c)", () => {
  it("the committed stylesheet was built from the current shared CSS", () => {
    const current = kanbanCssSourceHash();
    expect(
      KANBAN_CSS_SOURCE_HASH,
      "src/server/kanban-css.gen.ts is stale — run `node packages/cli/scripts/gen-kanban-css.mjs` (or `pnpm --filter @vibeflow-tools/cli build`) and commit the result",
    ).toBe(current);
  });
});
