/**
 * Story-level accessibility assertion (design-system P5.2).
 *
 * WHY THIS EXISTS SEPARATELY FROM `a11y-themes.test.tsx`:
 * that sweep imports the components directly and mirrors their args by hand, so
 * it proves the *components* are accessible in all six themes — it cannot see a
 * story that renders something extra (a bare `<img>`, a decorative div with
 * text, a duplicated landmark). Measured on 2026-11-11: injecting
 * `<img src="violation.png" />` into a story's render left that "every story,
 * every theme" sweep green.
 *
 * Running axe inside `play` closes that hole: the story is the thing rendered,
 * with its own args, decorators and markup. This assertion lives in the
 * browser, so it checks STRUCTURE — names, roles, labels, landmarks — which is
 * what a component's markup introduces and what cannot vary per theme.
 *
 * CONTRAST IS NOT CHECKED HERE, and the reason is measured rather than lazy:
 * a browser test cannot read or write files, so this helper has no way to hold
 * the design system's known contrast debt to account. The colour sweep lives in
 * `scripts/a11y-sweep.mjs`, which drives the same stories through Playwright
 * with real compositing, covers all six themes, and enforces an allowance
 * that may only shrink. Run `pnpm --filter @vibeflow-tools/ui run test:a11y`.
 *
 * History: this helper used to disable `color-contrast` while the manifest
 * claimed "axe-clean in all six themes". Nothing enforced that claim. The sweep
 * then found 386 distinct failing colour pairs, 207 below 3:1 — which is why
 * contrast is now a separate, measured gate instead of an implied promise.
 */
import axe from "axe-core";
import { expect } from "storybook/test";

type Violation = {
  id: string;
  impact?: string | null;
  help: string;
  nodes: Array<{ target: unknown; html?: string; failureSummary?: string }>;
};

function summarise(violations: Violation[]): string {
  return violations
    .map(
      (v) =>
        `${v.id} (${v.impact ?? "unknown"}): ${v.help} — ${v.nodes
          .map((n) => {
            // axe puts the measured colours and ratio in failureSummary; without
            // it a failure says "contrast" and names no colours to fix.
            const detail = (n.failureSummary ?? "")
              .replace(/\s+/g, " ")
              .replace(/^Fix any of the following: /, "")
              .slice(0, 180);
            return `${JSON.stringify(n.target)}${detail ? ` → ${detail}` : ""}`;
          })
          .join(", ")}`,
    )
    .join("\n");
}

/**
 * Assert the rendered story has zero structural axe violations.
 *
 * Failures name the rule, the impact and the offending selectors, because a
 * bare "expected 1 to be 0" tells the next person nothing about what to fix.
 */
export async function expectNoA11yViolations(root: HTMLElement): Promise<void> {
  const results = await axe.run(root, {
    rules: { "color-contrast": { enabled: false } },
  });

  const violations = results.violations as unknown as Violation[];
  expect(
    violations,
    `axe violations in this story:\n${summarise(violations)}`,
  ).toEqual([]);
}
