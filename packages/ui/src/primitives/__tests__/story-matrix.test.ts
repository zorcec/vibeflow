// @vitest-environment node
/**
 * Story-matrix manifest test (design-system P5.2) — every variant/state a
 * component declares must have a story with an interaction `play` function.
 * Reads the story SOURCES as text (no Storybook runtime needed) and checks
 * them against `story-matrix.manifest.ts`. See that file for how the next
 * component registers.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STORY_MATRIX } from "./story-matrix.manifest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(TEST_DIR, "../../..");
const STORIES_DIR = path.join(UI_ROOT, "stories");

function readStory(relativePath: string): string {
  return readFileSync(path.join(UI_ROOT, relativePath), "utf8");
}

/** All `export const <Name>` names in a story source file. */
function exportedStories(source: string): string[] {
  return [...source.matchAll(/export\s+const\s+(\w+)/g)].map((m) => m[1]);
}

/** Source slice belonging to `export const <name>` (up to the next export). */
function exportBlock(source: string, name: string): string {
  const matches = [...source.matchAll(/export\s+const\s+(\w+)/g)];
  const index = matches.findIndex((m) => m[1] === name);
  if (index === -1) return "";
  const start = matches[index].index ?? 0;
  const end =
    index + 1 < matches.length ? (matches[index + 1].index ?? source.length) : source.length;
  return source.slice(start, end);
}

describe("story matrix", () => {
  it("registers every story file on disk — nothing ships unregistered", () => {
    // RECURSIVE: primitives keep their stories in stories/primitives/, so a
    // flat readdir would silently stop guarding them (it did — the matrix
    // reported every story registered while two lived one directory deeper).
    const readStories = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return readStories(full);
        return entry.name.endsWith(".stories.tsx")
          ? [full.slice(STORIES_DIR.length + 1)]
          : [];
      });
    const onDisk = readStories(STORIES_DIR)
      .sort();
    // Compare relative-to-stories/ paths on BOTH sides: a basename comparison
    // cannot tell stories/button.stories.tsx from stories/primitives/button.stories.tsx.
    const inManifest = STORY_MATRIX.map((e) =>
      e.storyFile.replace(/^stories\//, ""),
    ).sort();
    expect(onDisk).toEqual(inManifest);
  });

  for (const entry of STORY_MATRIX) {
    describe(`${entry.component} (${entry.storyFile})`, () => {
      const source = readStory(entry.storyFile);

      it("declares the manifest title", () => {
        expect(source).toContain(`title: "${entry.title}"`);
      });

      it("uses the shared six-theme decorator", () => {
        expect(source).toContain("themeDecorator");
      });

      it("ships exactly the manifest stories — no fewer, no unregistered extras", () => {
        expect(exportedStories(source).sort()).toEqual(
          entry.stories.map((s) => s.name).sort(),
        );
      });

      for (const story of entry.stories) {
        it(`story ${story.name} exists and has an interaction play function`, () => {
          const block = exportBlock(source, story.name);
          expect(block, `missing export const ${story.name}`).not.toBe("");
          expect(block).toMatch(/\bplay\s*:/);
        });
      }
    });
  }
});
