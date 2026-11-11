// @vitest-environment node
/**
 * Template story guard (design-system P8) — the template story at
 * `src/templates/TemplateWidget.stories.tsx` is excluded from `tsc`
 * (it imports stories/a11y + .storybook/ThemeDecorator, which live outside
 * the tsconfig rootDir) and never runs as a story (Storybook only serves
 * `stories/*.stories.tsx`). Without this file it could rot silently.
 *
 * So this test reads it as source text — the same technique as
 * story-matrix.test.ts — and asserts every marker the scaffold and the
 * matrix gate depend on: the title, the shared decorator, one exported story
 * per tone with a `play` running story-level axe, and the exact import lines
 * the scaffold rewrites when it copies the file into `stories/`. If you
 * change the template story's imports, update the scaffold's rewrite table
 * (asserted below) to match.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(TEST_DIR, "../../..");
const STORY_SOURCE = readFileSync(
  path.join(UI_ROOT, "src/templates/TemplateWidget.stories.tsx"),
  "utf8",
);
const SCAFFOLD_SOURCE = readFileSync(
  path.join(UI_ROOT, "scripts/scaffold-component.mjs"),
  "utf8",
);

describe("template story", () => {
  it("declares the title the scaffold renames per component", () => {
    expect(STORY_SOURCE).toContain('title: "Design System/TemplateWidget"');
  });

  it("uses the shared six-theme decorator", () => {
    expect(STORY_SOURCE).toContain("themeDecorator");
  });

  it("ships exactly Quiet + Loud, each with a play running story-level axe", () => {
    for (const name of ["Quiet", "Loud"]) {
      const matches = [...STORY_SOURCE.matchAll(/export\s+const\s+(\w+)/g)];
      const index = matches.findIndex((m) => m[1] === name);
      expect(index, `missing export const ${name}`).not.toBe(-1);
      const start = matches[index].index ?? 0;
      const end =
        index + 1 < matches.length
          ? (matches[index + 1].index ?? STORY_SOURCE.length)
          : STORY_SOURCE.length;
      const block = STORY_SOURCE.slice(start, end);
      expect(block).toMatch(/\bplay\s*:/);
      expect(block).toContain("expectNoA11yViolations");
    }
  });

  it("imports the component via the package entry (never a …/src/… path)", () => {
    expect(STORY_SOURCE).toContain('from "./TemplateWidget"');
    expect(SCAFFOLD_SOURCE).toContain('from "../src"');
    expect(SCAFFOLD_SOURCE).not.toContain('from "../src/components/');
    expect(SCAFFOLD_SOURCE).toContain('} from "./components/');
  });

  it("imports stories/a11y + ThemeDecorator via the paths the scaffold rewrites", () => {
    for (const importLine of [
      'from "../../stories/a11y"',
      'from "../../.storybook/ThemeDecorator"',
    ]) {
      expect(STORY_SOURCE).toContain(importLine);
      expect(SCAFFOLD_SOURCE).toContain(importLine);
    }
  });
});
