import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliSrc = join(here, "..", "..", "src");
const uiFilesList = join(
  here,
  "..",
  "..",
  "..",
  "ui",
  "src",
  "kanban",
  "components",
  "shared",
  "FilesList.tsx",
);

function read(p: string): string {
  return readFileSync(p, "utf-8");
}

/**
 * D4 non-vacuity guard: provenance is a write-time flag, never a name match.
 * The 11 engine filenames may appear in exactly one place — the migration
 * const in core/files.ts. Any name-matching re-added to a render/read path
 * (listFiles, file routes, FilesList) fails this test.
 *
 * Filename-shaped literals only (`baseline-`, `baseline.`, `verify-`):
 * prose words like "baselines" or "verify evidence" must not trip the guard.
 */
describe("no name-matching outside the migration const", () => {
  const NAME_PATTERN = /baseline[-.]|verify-/i;

  it("core/files.ts mentions engine names only inside SYSTEM_FILE_NAMES", () => {
    const src = read(join(cliSrc, "core", "files.ts"));
    const constKeyword = "const SYSTEM_FILE_NAMES";
    const start = src.indexOf(constKeyword);
    expect(start).toBeGreaterThan(-1);
    const setClose = src.indexOf(")", src.indexOf("[", start));
    const end = src.indexOf(";", setClose);
    expect(end).toBeGreaterThan(start);
    const rest = src.slice(0, start) + src.slice(end + 1);
    expect(rest).not.toMatch(NAME_PATTERN);
  });

  it("server file routes do not match on names; baseline writers flag", () => {
    const src = read(join(cliSrc, "server", "server.ts"));
    const filesApiStart = src.indexOf("// Files API");
    expect(filesApiStart).toBeGreaterThan(-1);
    const baselineRoute = src.indexOf(
      "// POST /api/tasks/:id/baseline",
      filesApiStart,
    );
    expect(baselineRoute).toBeGreaterThan(filesApiStart);
    const fileRoutes = src.slice(filesApiStart, baselineRoute);
    expect(fileRoutes).not.toMatch(NAME_PATTERN);
    expect(fileRoutes).not.toMatch(/\.test\(|RegExp|startsWith|endsWith/);
    // Positive: both baseline write routes stamp the flag.
    const writerSection = src.slice(baselineRoute);
    expect(writerSection).toMatch(/baseline-element\.json[\s\S]*?system: true/);
    expect(writerSection).toMatch(/baseline-page\.json[\s\S]*?system: true/);
  });

  it("FilesList groups by flag only", () => {
    const src = read(uiFilesList);
    expect(src).toMatch(/f\.system === true/);
    expect(src).not.toMatch(NAME_PATTERN);
    expect(src).not.toMatch(/\.test\(|RegExp|\.png/);
    expect(src).not.toMatch(/startsWith|endsWith/);
  });

  it("all verify.ts engine writes carry the flag", () => {
    const src = read(join(cliSrc, "commands", "verify.ts"));
    const flagged = src.match(/\{\s*system: true\s*,?\s*\}/g) ?? [];
    // 8 storeEvidence writes + all-styles re-save + page-diff = 10 sites.
    expect(flagged.length).toBeGreaterThanOrEqual(10);
  });
});
