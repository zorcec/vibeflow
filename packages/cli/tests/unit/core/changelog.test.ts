import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import chalk from "chalk";
import {
  parseChangelogSections,
  getLatestSection,
  getSectionByVersion,
  changelogText,
  readChangelogContent,
  buildChangelogResponse,
  formatSectionForTerminal,
} from "../../../src/core/changelog.js";

const strip = (s: string) => s.replace(/\u001b\[\d+m/g, "");

const SAMPLE = `# Changelog

## 0.2.0

### Minor Changes

- abc1234: Feature one

  - nested bullet

### Patch Changes

- def5678: Fix one

## 0.1.0

### Patch Changes

- 9abcdef: First fix
`;

describe("parseChangelogSections", () => {
  it("splits content into per-version sections in file order", () => {
    const sections = parseChangelogSections(SAMPLE);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.version).toBe("0.2.0");
    expect(sections[1]?.version).toBe("0.1.0");
  });

  it("captures all markdown between headers, excluding the next header", () => {
    const [first] = parseChangelogSections(SAMPLE);
    expect(first?.markdown).toContain("### Minor Changes");
    expect(first?.markdown).toContain("Feature one");
    expect(first?.markdown).toContain("nested bullet");
    expect(first?.markdown).not.toContain("## 0.1.0");
  });

  it("ignores content before the first version header", () => {
    const sections = parseChangelogSections(SAMPLE);
    expect(sections[0]?.markdown).not.toContain("# Changelog");
  });

  it("supports prerelease version suffixes", () => {
    const sections = parseChangelogSections("## 1.2.3-beta.1\n\n- x: y\n");
    expect(sections[0]?.version).toBe("1.2.3-beta.1");
  });

  it("rejects non-version ## headers", () => {
    expect(parseChangelogSections("## Unreleased\n\n- stuff")).toEqual([]);
  });

  it("returns empty array for empty or headerless content", () => {
    expect(parseChangelogSections("")).toEqual([]);
    expect(parseChangelogSections("just text")).toEqual([]);
  });

  it("handles trailing section with no newline at EOF", () => {
    const sections = parseChangelogSections("## 0.1.0\n\n- a: b");
    expect(sections[0]?.markdown).toBe("- a: b");
  });
});

describe("getLatestSection / getSectionByVersion", () => {
  const sections = parseChangelogSections(SAMPLE);

  it("getLatestSection returns the first (newest) section", () => {
    expect(getLatestSection(sections)?.version).toBe("0.2.0");
    expect(getLatestSection([])).toBeNull();
  });

  it("getSectionByVersion finds exact matches", () => {
    expect(getSectionByVersion(sections, "0.1.0")?.markdown).toContain(
      "First fix",
    );
  });

  it("getSectionByVersion returns null for unknown versions", () => {
    expect(getSectionByVersion(sections, "9.9.9")).toBeNull();
  });
});

describe("formatSectionForTerminal", () => {
  it("renders version header, category headers and body lines", () => {
    const section = getLatestSection(parseChangelogSections(SAMPLE));
    expect(section).not.toBeNull();
    const out = strip(formatSectionForTerminal(section!));
    expect(out).toContain("What's new in 0.2.0");
    expect(out).toContain("Minor Changes");
    expect(out).toContain("Feature one");
    expect(out).toContain("Patch Changes");
  });
});

describe("changelogText", () => {
  const sections = parseChangelogSections(SAMPLE);

  it("shows only the latest section by default", () => {
    const out = strip(changelogText(SAMPLE));
    expect(out).toContain("What's new in 0.2.0");
    expect(out).not.toContain("0.1.0");
  });

  it("shows every section with all: true", () => {
    const out = strip(changelogText(SAMPLE, { all: true }));
    expect(out).toContain("What's new in 0.2.0");
    expect(out).toContain("What's new in 0.1.0");
    // sections separated by a blank line
    expect(out).toMatch(/Fix one\n\n\s+What's new in 0\.1\.0/);
  });

  it("returns empty string for unparseable content", () => {
    expect(changelogText("")).toBe("");
    expect(changelogText("nothing here")).toBe("");
  });

  it("keeps chalk styling on the header when color is supported", () => {
    const out = changelogText(SAMPLE);
    if (chalk.level > 0) {
      expect(out).toContain("\u001b[1m"); // bold
    } else {
      expect(out).toContain("What's new in 0.2.0");
    }
    expect(strip(out)).toContain(sections[0]?.version ?? "");
  });
});

describe("readChangelogContent", () => {
  it("finds the CLI's own CHANGELOG.md when run from source", () => {
    const content = readChangelogContent();
    expect(content).not.toBeNull();
    expect(content).toContain("# Changelog");
  });

  it("resolves a sibling CHANGELOG.md relative to the base dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-changelog-"));
    const nested = join(dir, "core");
    try {
      // Layout mirrors dist/cli/index.js → package root/CHANGELOG.md
      writeFileSync(join(dir, "CHANGELOG.md"), "## 9.9.9\n\n- from temp\n");
      const content = readChangelogContent(nested);
      expect(content).toContain("from temp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a grandparent CHANGELOG.md (src/core → package root)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-changelog2-"));
    try {
      writeFileSync(join(dir, "CHANGELOG.md"), "## 8.8.8\n\n- grand\n");
      const deep = join(dir, "a", "b");
      const content = readChangelogContent(deep);
      expect(content).toContain("grand");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no changelog exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-changelog-missing-"));
    try {
      expect(readChangelogContent(join(dir, "deep"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws when a candidate path is unreadable", () => {
    // A directory named CHANGELOG.md makes readFileSync throw internally.
    const dir = mkdtempSync(join(tmpdir(), "vf-changelog-dir-"));
    try {
      const nested = join(dir, "core");
      mkdirSync(join(dir, "CHANGELOG.md"));
      expect(readChangelogContent(nested)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildChangelogResponse", () => {
  it("returns version + sections from content", () => {
    const res = buildChangelogResponse(SAMPLE);
    expect(res.version).toBe("0.2.0");
    expect(res.sections).toHaveLength(2);
  });

  it("returns empty payload for null content", () => {
    expect(buildChangelogResponse(null)).toEqual({
      version: null,
      sections: [],
    });
  });
});
