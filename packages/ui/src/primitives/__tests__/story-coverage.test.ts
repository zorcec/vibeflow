/**
 * Story coverage guard (audit A2).
 *
 * Two rules, both enforced mechanically so nobody has to remember them:
 *
 *  1. Every component exported from `src/**` has a story.
 *  2. Every option value a component declares (each `cva` axis value) is
 *     exercised by a story, by NAME.
 *
 * The naming convention is the enforcement mechanism and is deliberately
 * boring: an option value appears in a story export name in PascalCase —
 * `variant: "primary"` → an export starting `Primary`, `size: "md"` → an
 * export ending `Md`, any other axis → the token appearing anywhere. That is
 * how the Button matrix already reads (`PrimarySm`, `SecondaryLg`, …), so the
 * convention documents itself to a reviewer scanning Storybook.
 *
 * Why a static parse instead of rendering every story: this runs in the fast
 * unit lane (milliseconds, no browser) and its failure message names the exact
 * missing story, so the fix is obvious. Rendering lives in `test:stories`.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "../../..");
const SRC = path.join(PKG, "src");
const STORIES = path.join(PKG, "stories");

/** Files that are not components or that the staged build owns. */
const SKIP_DIR = /(__tests__|node_modules|\.storybook|storybook-static|dist)/;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP_DIR.test(full)) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.stories\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** PascalCase candidate that is a React component: starts upper, has a
 *  lowercase letter (rules out CARD_TITLE_TIP_MAX_W and other constants). */
const isComponentName = (n: string) => /^[A-Z][A-Za-z0-9]*$/.test(n) && /[a-z]/.test(n);

function exportsOf(file: string): string[] {
  const s = fs.readFileSync(file, "utf8");
  const names: string[] = [];
  for (const m of s.matchAll(/^export (?:function|const) ([A-Za-z0-9_]+)/gm)) {
    if (isComponentName(m[1])) names.push(m[1]);
  }
  return names;
}

/** A file with JSX in its return is a component file; constants files are not. */
function rendersJsx(file: string): boolean {
  const s = fs.readFileSync(file, "utf8");
  return /return \(?\s*</.test(s) || /<[A-Za-z][^>]*>/.test(s);
}

interface StoryFile {
  file: string;
  rel: string;
  title: string;
  component: string | null;
  exports: string[];
  argsBlock: string;
}

/** Story files themselves: `walk` deliberately skips them for the src scan. */
function walkStories(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP_DIR.test(full)) continue;
    if (entry.isDirectory()) walkStories(full, out);
    else if (/\.stories\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

function storyFiles(): StoryFile[] {
  const out: StoryFile[] = [];
  // Stories live under stories/ AND beside a few components (src/templates).
  for (const file of [...walkStories(STORIES), ...walkStories(SRC)]) {
    const s = fs.readFileSync(file, "utf8");
    // The P8 scaffold ships a copy-me story template that Storybook never
    // loads (`stories: ["../stories/**"]`) and tsc excludes. It declares that
    // itself with a template-note block, so it is skipped on its own evidence
    // rather than on a filename someone could copy.
    if (s.includes("template-note:start")) continue;
    // The meta title is the first `title:` inside a `const meta`/`export default`
    // region; story bodies never declare `title:` in this package, but a task
    // fixture could, so anchor on the meta block when it is findable.
    const metaAt = s.search(/(const meta\b|export default\s*\{)/);
    const head = metaAt >= 0 ? s.slice(metaAt) : s;
    const title = (head.match(/title:\s*"([^"]+)"/) ?? [])[1] ?? "";
    const component = (head.match(/component:\s*([A-Z]\w*)/) ?? [])[1] ?? null;
    const exports = [...s.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
    // Everything after the meta: the stories themselves.
    out.push({ file, rel: path.relative(PKG, file), title, component, exports, argsBlock: head });
  }
  return out;
}

/**
 * Parse `cva(...)` — returns axis → declared values. Brace-aware so a nested
 * object (a compound variant, or a style map) cannot truncate the scan.
 */
function cvaAxes(file: string): Record<string, string[]> {
  const s = fs.readFileSync(file, "utf8");
  const start = s.indexOf("cva(");
  if (start === -1) return {};
  const vIdx = s.indexOf("variants:", start);
  if (vIdx === -1) return {};
  const open = s.indexOf("{", vIdx);
  let depth = 0;
  let end = -1;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === "{") depth += 1;
    else if (s[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return {};
  // Strip string literals and comments BEFORE scanning for keys. The class
  // values contain `hover:bg-accent` / `active:text-white`, and a key scanner
  // that cannot tell a string from code reports `variant: "hover"` — a gap
  // that does not exist. A guard that lies is worse than no guard.
  const block = stripLiterals(s.slice(open + 1, end));

  const axes: Record<string, string[]> = {};
  // Axis names sit at depth 0 of this block: `<name>: {`.
  let depth2 = 0;
  let axisName: string | null = null;
  let axisOpen = -1;
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i];
    if (ch === "{") {
      depth2 += 1;
      if (depth2 === 1) {
        // The axis name precedes this brace: read it backwards.
        const before = block.slice(0, i).match(/(\w+)\s*:\s*$/);
        axisName = before ? before[1] : null;
        axisOpen = i;
      }
    } else if (ch === "}") {
      depth2 -= 1;
      if (depth2 === 0 && axisName && axisOpen >= 0) {
        const body = block.slice(axisOpen + 1, i);
        const values = topLevelKeys(body);
        if (values.length) axes[axisName] = values;
        axisName = null;
        axisOpen = -1;
      }
    }
  }
  return axes;
}

/**
 * Keys declared at the top level of an object body, found by depth rather than
 * indentation — the sources use 8 spaces for axis values and 6 for something
 * else, and a regex tied to either breaks the moment a file is reformatted.
 */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    const m = body.slice(i).match(/^(\w+)\s*:/);
    if (!m) continue;
    const prev = i === 0 ? "," : body[i - 1];
    if (/[\s,{]/.test(prev)) keys.push(m[1]);
  }
  return [...new Set(keys)];
}

/**
 * Components that are deliberately covered by a PARENT's story instead of
 * their own. Every entry names the story that renders it and why a standalone
 * story would add nothing — a sub-part that cannot be rendered without its
 * parent is not a component a reviewer can look at on its own.
 *
 * Keep this list short and justified; it exists so the rule stays honest
 * rather than to make the test pass.
 */
/**
 * Components that are not part of the design system and therefore need no
 * story. Keep this list tiny and justified — it is not an escape hatch.
 */
const NOT_DESIGN_SYSTEM: Record<string, string> = {
  TemplateWidget:
    "P8 scaffold demo: its story is the copy-me template (template-note block), Storybook never loads it, and tsc excludes it",
};

const COVERED_BY_PARENT: Record<string, string> = {
  StatusDot: "TaskCard stories render it in every status tone",
  AgentBadge: "Collab stories badge agent-origin rows",
  AttributionName: "Collab stories render the attribution row",
  HeaderActionButton: "Header stories render the action buttons",
  FileItem: "DetailPanel/Files tab renders it",
  VerifyIndicator: "DetailPanel stories show the verify state",
  LeadingSlot: "TaskCard stories render the leading slot",
  CardTitle: "TaskCard stories render the title",
  BadgeCluster: "TaskCard stories render the badge cluster",
  LiveActivityBadge: "TaskCard stories render the live badge",
  FileItemRow: "DetailPanel/Files tab renders it",
};

/** Blank out string literals and comments so only code-shaped text remains. */
function stripLiterals(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const pascal = (v: string) => v.charAt(0).toUpperCase() + v.slice(1).replace(/[^A-Za-z0-9]/g, "");

describe("story coverage", () => {
  const stories = storyFiles();
  const allStoryNames = stories.flatMap((s) => s.exports);
  const argsText = stories.map((s) => s.argsBlock).join("\n");

  it("has a story file for every component exported from src", () => {
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      if (!/\.tsx$/.test(file)) continue;
      if (!rendersJsx(file)) continue;
      for (const name of exportsOf(file)) {
        // A component is covered when some story declares it as its
        // `component`, or its title's last segment names it, or the story
        // file is its kebab-case twin.
        const covered = stories.some(
          (s) =>
            s.component === name ||
            s.title.split("/").pop() === name ||
            path.basename(s.rel).toLowerCase() === `${kebab(name)}.stories.tsx`,
        );
        if (!covered && !COVERED_BY_PARENT[name] && !NOT_DESIGN_SYSTEM[name]) missing.push(`${name} (${path.relative(PKG, file)})`);
      }
    }
    expect(
      missing,
      `Components with no story. Add stories/<area>/<kebab>.stories.tsx with ` +
        `title "Design System/<Area>/${"<Name>"}" and component: <Name>:\n  ` +
        missing.join("\n  "),
    ).toEqual([]);
  });

  it("exercises every declared option value by name", () => {
    const gaps: string[] = [];
    for (const file of walk(SRC)) {
      if (!/\.tsx$/.test(file)) continue;
      const axes = cvaAxes(file);
      if (!Object.keys(axes).length) continue;
      const [component] = exportsOf(file);
      if (!component || NOT_DESIGN_SYSTEM[component]) continue;
      const own = stories.filter(
        (s) => s.component === component || s.title.split("/").pop() === component,
      );
      const names = own.flatMap((s) => s.exports).join(" ");
      for (const [axis, values] of Object.entries(axes)) {
        for (const value of values) {
          const token = pascal(value);
          const byName = new RegExp(`(^|[^a-z])${token}`).test(names);
          // Args-based coverage is equally valid and often clearer for a
          // state axis (`state: "error"`).
          const byArgs = new RegExp(`${axis}\\s*:\\s*["']${value}["']`).test(argsText);
          if (!byName && !byArgs) {
            gaps.push(`${component} ${axis}="${value}" (no story named *${token}*, no args)`);
          }
        }
      }
    }
    expect(
      gaps,
      `Option values with no story. Name one export so the value is visible to a ` +
        `reviewer (variant primary → PrimarySm, size md → …Md), or pass it in args:\n  ` +
        gaps.join("\n  "),
    ).toEqual([]);
  });

  it("registers every story file in the story matrix manifest", () => {
    // The matrix test owns the exact-set check; this one only pins that the
    // coverage guard and the manifest agree about which files exist, so a new
    // story cannot satisfy this test while staying invisible to the matrix.
    const manifest = fs.readFileSync(
      path.join(SRC, "primitives/__tests__/story-matrix.manifest.ts"),
      "utf8",
    );
    const unlisted = stories
      .map((s) => s.rel)
      .filter((rel) => !manifest.includes(rel));
    expect(unlisted, `Story files missing from story-matrix.manifest.ts:\n  ${unlisted.join("\n  ")}`).toEqual([]);
  });

  it("keeps the convention discoverable: every story title is under Design System/", () => {
    const odd = stories.filter((s) => !s.title.startsWith("Design System/")).map((s) => `${s.rel} → "${s.title}"`);
    expect(
      odd,
      `Stories must live under "Design System/<Area>/<Component>" so the Storybook ` +
        `sidebar groups them for review:\n  ${odd.join("\n  ")}`,
    ).toEqual([]);
  });

  it("runs an accessibility check in every story file", () => {
    // Measured: `parameters.a11y.test: "error"` from @storybook/addon-a11y does
    // NOT fail a story in this vitest setup — a story rendering an <img> with
    // no alt passed. What does fail it is `expectNoA11yViolations()` inside the
    // play function (verified: image-alt, critical). So the guarantee is that
    // call, and this rule keeps it in every file rather than trusting a config
    // flag that does nothing.
    const missing = stories
      .filter((s) => !fs.readFileSync(s.file, "utf8").includes("expectNoA11yViolations("))
      .map((s) => s.rel);
    expect(
      missing,
      `Story files with no accessibility check. Add 'await expectNoA11yViolations(canvasElement);' ` +
        `to at least one play function:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("allStoryNames is non-empty (the guard is reading the files it claims to)", () => {
    expect(allStoryNames.length).toBeGreaterThan(40);
  });
});

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
