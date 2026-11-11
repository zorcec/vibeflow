#!/usr/bin/env node
/**
 * Scaffold a design-system component (P8).
 *
 *   node packages/ui/scripts/scaffold-component.mjs <Name>
 *
 * Writes four things so the story-matrix guard is satisfied on the first
 * commit with no hand edits:
 *   1. packages/ui/src/components/<Name>.tsx
 *   2. packages/ui/stories/<Name>.stories.tsx
 *   3. packages/ui/src/components/__tests__/<Name>.test.tsx
 *   4. a STORY_MATRIX entry in
 *      packages/ui/src/primitives/__tests__/story-matrix.manifest.ts
 *
 * Source of truth is the template (packages/ui/src/templates/):
 * the component and test copy verbatim apart from the `TemplateWidget`
 * rename; the story additionally needs three import-path rewrites because
 * it moves from src/templates/ to stories/:
 *   - `from "./TemplateWidget"`            -> `from "../src/components/<Name>"`
 *   - `from "../../stories/a11y"`          -> `from "./a11y"`
 *   - `from "../../.storybook/ThemeDecorator"` -> `from "../.storybook/ThemeDecorator"`
 *
 * Refuses (exit 1, message on stderr): missing/empty name, a name that is
 * not PascalCase (/^[A-Z][A-Za-z0-9]*$/), or any target that already
 * exists — component file, story file, test file, or manifest entry.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(HERE, "..");
const TEMPLATE_NAME = "TemplateWidget";

const name = process.argv[2];

function refuse(message) {
  console.error(`scaffold-component: refusing — ${message}`);
  process.exit(1);
}

if (!name) {
  refuse(
    "no component name given. Usage: node packages/ui/scripts/scaffold-component.mjs <Name> (e.g. InfoBadge).",
  );
}
if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
  refuse(
    `invalid component name "${name}" — use PascalCase starting with a capital letter, letters and digits only (e.g. InfoBadge, not foo-bar or 1Bad).`,
  );
}

const componentFile = path.join(UI_ROOT, "src", "components", `${name}.tsx`);
const storyFile = path.join(UI_ROOT, "stories", `${name}.stories.tsx`);
const testFile = path.join(
  UI_ROOT,
  "src",
  "components",
  "__tests__",
  `${name}.test.tsx`,
);
const manifestFile = path.join(
  UI_ROOT,
  "src",
  "primitives",
  "__tests__",
  "story-matrix.manifest.ts",
);

for (const file of [componentFile, storyFile, testFile]) {
  if (existsSync(file)) {
    refuse(
      `"${name}" already exists (${path.relative(UI_ROOT, file)} is on disk) — pick another name or edit the existing component.`,
    );
  }
}
const manifestSource = readFileSync(manifestFile, "utf8");
if (
  manifestSource.includes(`component: "${name}"`) ||
  manifestSource.includes(`stories/${name}.stories.tsx`)
) {
  refuse(
    `"${name}" is already registered in story-matrix.manifest.ts — pick another name or edit the existing entry.`,
  );
}

function readTemplate(relativePath) {
  return readFileSync(path.join(UI_ROOT, "src", "templates", relativePath), "utf8");
}

/**
 * Template-only prose (template-note:start … template-note:end) is
 * stripped from scaffolded copies — it describes the template, so it would
 * be false in the copy. Everything outside those blocks is context-neutral
 * and ships verbatim apart from the rename (+ the story's import rewrites).
 */
function stripTemplateNotes(source) {
  return source.replace(
    /\/\* template-note:start[\s\S]*?template-note:end \*\//g,
    "",
  );
}

const rename = (source) =>
  source.replaceAll(TEMPLATE_NAME, name);

const componentSource = stripTemplateNotes(
  rename(readTemplate(`${TEMPLATE_NAME}.tsx`)),
);
const testSource = stripTemplateNotes(
  rename(readTemplate(path.join("__tests__", `${TEMPLATE_NAME}.test.tsx`))),
);
const storySource = stripTemplateNotes(
  rename(readTemplate(`${TEMPLATE_NAME}.stories.tsx`)
    .replaceAll(
      `from "./${TEMPLATE_NAME}"`,
      `from "../src/components/${name}"`,
    )
    .replaceAll(`from "../../stories/a11y"`, `from "./a11y"`)
    .replaceAll(
      `from "../../.storybook/ThemeDecorator"`,
      `from "../.storybook/ThemeDecorator"`,
    ),
  ),
);

const manifestEntry =
  `  {\n` +
  `    component: "${name}",\n` +
  `    storyFile: "stories/${name}.stories.tsx",\n` +
  `    title: "Design System/${name}",\n` +
  `    stories: [\n` +
  `      { name: "Quiet", covers: 'tone="quiet" default render + action interaction' },\n` +
  `      { name: "Loud", covers: 'tone="loud" accent render + action interaction' },\n` +
  `    ],\n` +
  `  },\n`;

const closeIndex = manifestSource.lastIndexOf("\n];");
if (closeIndex === -1) {
  refuse(
    "story-matrix.manifest.ts has no closing `];` — the manifest format changed; update the scaffold to match.",
  );
}
const manifestNext =
  `${manifestSource.slice(0, closeIndex + 1)}${manifestEntry}${manifestSource.slice(closeIndex + 1)}`;

mkdirSync(path.dirname(componentFile), { recursive: true });
mkdirSync(path.dirname(testFile), { recursive: true });
writeFileSync(componentFile, componentSource);
writeFileSync(storyFile, storySource);
writeFileSync(testFile, testSource);
writeFileSync(manifestFile, manifestNext);

for (const file of [componentFile, storyFile, testFile, manifestFile]) {
  console.log(`created: ${path.relative(UI_ROOT, file)}`);
}
