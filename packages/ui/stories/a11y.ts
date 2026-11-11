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
 * with its own args, decorators and markup. Per-theme coverage stays with the
 * component sweep; this guards the story surface itself.
 */
import axe from "axe-core";
import { expect } from "storybook/test";

type Violation = {
  id: string;
  impact?: string | null;
  help: string;
  nodes: Array<{ target: unknown }>;
};

/**
 * Assert the rendered story has zero axe violations.
 *
 * Failures name the rule, the impact and the offending selectors, because a
 * bare "expected 1 to be 0" tells the next person nothing about what to fix.
 */
export async function expectNoA11yViolations(root: HTMLElement): Promise<void> {
  const results = await axe.run(root, {
    // Colour contrast needs a real compositing pass; the six-theme component
    // sweep covers it. Story-level runs stay on structure, labels and roles,
    // which are the failures a component's markup introduces.
    rules: { "color-contrast": { enabled: false } },
  });

  const violations = results.violations as unknown as Violation[];
  const summary = violations
    .map(
      (v) =>
        `${v.id} (${v.impact ?? "unknown"}): ${v.help} — ${v.nodes
          .map((n) => JSON.stringify(n.target))
          .join(", ")}`,
    )
    .join("\n");

  expect(violations, `axe violations in this story:\n${summary}`).toEqual([]);
}
