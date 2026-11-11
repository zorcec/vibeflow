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
 * plus an export of the component from the package entry
 * (packages/ui/src/index.ts) so stories import it via `from "../src"`
 * per the no-deep-imports guard (P9).
 *
 * Source of truth is the template (packages/ui/src/templates/):
 * the component and test copy verbatim apart from the `TemplateWidget`
 * rename; the story additionally needs three import-path rewrites because
 * it moves from src/templates/ to stories/:
 *   - `from "./TemplateWidget"`            -> `from "../src"` (package entry,
 *      per the no-deep-imports guard — never a `…/src/…` file path)
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

/**
 * Two accepted forms, so the ticket's documented command works:
 *   node scripts/scaffold-component.mjs InfoBadge
 *   node scripts/scaffold-component.mjs --name InfoBadge [--kind primitive]
 *
 * `--kind primitive` puts the files where primitives live (lowercase filename
 * under src/primitives/, story under stories/primitives/), because that is the
 * layout the ticket and the story matrix use; the default keeps the generic
 * components/ layout.
 */
const argv = process.argv.slice(2);
function flag(flagName) {
  const i = argv.indexOf(`--${flagName}`);
  return i === -1 ? undefined : argv[i + 1];
}
const name = flag("name") ?? argv.find((a) => !a.startsWith("--"));
const kind = flag("kind") ?? "component";
if (kind !== "primitive" && kind !== "component") {
  console.error(
    `scaffold-component: refusing — unknown --kind "${kind}" (expected "primitive" or "component").`,
  );
  process.exit(1);
}

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

const fileBase = kind === "primitive" ? name.toLowerCase() : name;
const componentDir = kind === "primitive" ? ["src", "primitives"] : ["src", "components"];
const storyDir = kind === "primitive" ? ["stories", "primitives"] : ["stories"];
const storyRel = [...storyDir, `${fileBase}.stories.tsx`].join("/");
const componentFile = path.join(UI_ROOT, ...componentDir, `${fileBase}.tsx`);
const storyFile = path.join(UI_ROOT, ...storyDir, `${fileBase}.stories.tsx`);
const testFile = path.join(
  UI_ROOT,
  ...componentDir,
  "__tests__",
  `${fileBase}.test.tsx`,
);
const manifestFile = path.join(
  UI_ROOT,
  "src",
  "primitives",
  "__tests__",
  "story-matrix.manifest.ts",
);
const entryFile = path.join(UI_ROOT, "src", "index.ts");

for (const file of [componentFile, storyFile, testFile]) {
  if (existsSync(file)) {
    refuse(
      `"${name}" already exists (${path.relative(UI_ROOT, file)} is on disk) — pick another name or edit the existing component.`,
    );
  }
}
const manifestSource = readFileSync(manifestFile, "utf8");
const entrySource = readFileSync(entryFile, "utf8");
if (entrySource.includes(`${path.basename(componentDir[1])}/${fileBase}`)) {
  refuse(
    `"${name}" is already exported from src/index.ts — pick another name or edit the existing entry.`,
  );
}
if (
  manifestSource.includes(`component: "${name}"`) ||
  manifestSource.includes(storyRel)
) {
  refuse(
    `"${name}" is already registered in story-matrix.manifest.ts — pick another name or edit the existing entry.`,
  );
}

/**
 * Rewrite a generated file's relative imports for the directory it actually
 * landed in. The template is written for the flat `stories/` layout; a
 * primitive's story sits in `stories/primitives/`, one level deeper, so every
 * `from "../x"` must gain a `../`.
 */
function fixStoryDepth(source, depthDelta) {
  if (depthDelta === 0) return source;
  return source
    .replace(/from "\.\.\/src"/g, 'from "../../src"')
    .replace(/from "\.\/a11y"/g, 'from "../a11y"')
    .replace(/from "\.\.\/\.storybook\//g, 'from "../../.storybook/');
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
  // The test imports the component by its FILE name: primitives use the
  // lowercased file, components keep the PascalCase one.
  rename(readTemplate(path.join("__tests__", `${TEMPLATE_NAME}.test.tsx`)))
    .replaceAll(`from "../${name}"`, `from "../${fileBase}"`),
);
const storySource = stripTemplateNotes(
  rename(readTemplate(`${TEMPLATE_NAME}.stories.tsx`)
    .replaceAll(
      `from "./${TEMPLATE_NAME}"`,
      `from "../src"`,
    )
    .replaceAll(
      `from "../../stories/a11y"`,
      kind === "primitive" ? `from "../a11y"` : `from "./a11y"`,
    )
    .replaceAll(
      `from "../../.storybook/ThemeDecorator"`,
      `from "../.storybook/ThemeDecorator"`,
    ),
  ),
);

const manifestEntry =
  `  {\n` +
  `    component: "${name}",\n` +
  `    storyFile: "${storyRel}",\n` +
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

// Package entry: stories import the component via `from "../src"`, so the
// scaffold registers it here (P9 no-deep-imports guard). Appended last —
// index.ts is legacy-tree order, not alphabetical, so position is neutral.
const entryNext =
  `${entrySource.trimEnd()}\n\n// Design-system component (scaffolded ${name}) — kept in the entry so\n` +
  `// stories import it via the package entry, never a …/src/… file path.\n` +
  `export { ${name} } from "./${path.basename(componentDir[1])}/${fileBase}";\n`;

mkdirSync(path.dirname(componentFile), { recursive: true });
mkdirSync(path.dirname(testFile), { recursive: true });
writeFileSync(componentFile, componentSource);
writeFileSync(storyFile, fixStoryDepth(storySource, kind === "primitive" ? 1 : 0));
writeFileSync(testFile, testSource);
writeFileSync(manifestFile, manifestNext);
writeFileSync(entryFile, entryNext);

for (const file of [componentFile, storyFile, testFile, manifestFile, entryFile]) {
  console.log(`created: ${path.relative(UI_ROOT, file)}`);
}
