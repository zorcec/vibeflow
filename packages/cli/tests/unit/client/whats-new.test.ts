import { describe, it, expect } from "vitest";
import {
  isVersionNewer,
  shouldShowWhatsNew,
  readStoredVersion,
  markVersionSeen,
  pickWhatsNewSection,
  sectionsSince,
  whatsNewMarkdown,
  fullChangelogMarkdown,
  LAST_SEEN_VERSION_KEY,
  type ChangelogSection,
} from "../../../src/client/kanban/whats-new.js";

const sections: ChangelogSection[] = [
  { version: "0.2.0", markdown: "### Minor Changes\n\n- a: new thing" },
  { version: "0.1.0", markdown: "### Patch Changes\n\n- b: old fix" },
];

describe("isVersionNewer", () => {
  it("compares major, minor, patch numerically", () => {
    expect(isVersionNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isVersionNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isVersionNewer("0.1.0", "0.2.0")).toBe(false);
    expect(isVersionNewer("0.1.0", "0.1.0")).toBe(false);
  });

  it("survives non-numeric segments like prerelease suffixes", () => {
    expect(isVersionNewer("1.0.1-beta.2", "1.0.0")).toBe(true);
  });
});

describe("shouldShowWhatsNew", () => {
  it("shows when the current version is newer than the stored one", () => {
    expect(shouldShowWhatsNew("0.1.0", "0.2.0")).toBe(true);
  });

  it("does not show on first visit (no stored version)", () => {
    expect(shouldShowWhatsNew(null, "0.2.0")).toBe(false);
  });

  it("does not show when already seen", () => {
    expect(shouldShowWhatsNew("0.2.0", "0.2.0")).toBe(false);
  });

  it("does not show when current version is unknown or empty", () => {
    expect(shouldShowWhatsNew("0.1.0", "")).toBe(false);
  });

  it("does not show on downgrade", () => {
    expect(shouldShowWhatsNew("0.9.9", "0.2.0")).toBe(false);
  });
});

describe("localStorage helpers (node env: no storage)", () => {
  it("readStoredVersion returns null when storage is unavailable", () => {
    expect(readStoredVersion()).toBeNull();
  });

  it("markVersionSeen does not throw when storage is unavailable", () => {
    expect(() => markVersionSeen("0.2.0")).not.toThrow();
  });

  it("exposes the expected localStorage key", () => {
    expect(LAST_SEEN_VERSION_KEY).toBe("vibeflow-last-seen-version");
  });
});

describe("pickWhatsNewSection", () => {
  it("prefers the exact version match", () => {
    expect(pickWhatsNewSection(sections, "0.1.0")?.version).toBe("0.1.0");
  });

  it("falls back to the latest section when no match exists", () => {
    expect(pickWhatsNewSection(sections, "9.9.9")?.version).toBe("0.2.0");
  });

  it("returns null for an empty list", () => {
    expect(pickWhatsNewSection([], "0.1.0")).toBeNull();
  });
});

describe("markdown builders", () => {
  it("whatsNewMarkdown prefixes the version header", () => {
    const md = whatsNewMarkdown(sections[0] ?? null);
    expect(md.startsWith("## 0.2.0\n\n")).toBe(true);
    expect(md).toContain("new thing");
  });

  it("whatsNewMarkdown handles null", () => {
    expect(whatsNewMarkdown(null)).toBe("");
  });

  it("fullChangelogMarkdown joins all sections newest first", () => {
    const md = fullChangelogMarkdown(sections);
    expect(md).toContain("## 0.2.0");
    expect(md).toContain("## 0.1.0");
    expect(md.indexOf("## 0.2.0")).toBeLessThan(md.indexOf("## 0.1.0"));
    expect(md).toContain("old fix");
  });

  it("fullChangelogMarkdown of no sections is empty", () => {
    expect(fullChangelogMarkdown([])).toBe("");
  });
});

describe("sectionsSince", () => {
  const fourSections: ChangelogSection[] = [
    { version: "0.4.0", markdown: "v0.4" },
    { version: "0.3.0", markdown: "v0.3" },
    { version: "0.2.0", markdown: "v0.2" },
    { version: "0.1.0", markdown: "v0.1" },
  ];

  it("returns all sections when sinceVersion is null", () => {
    expect(sectionsSince(fourSections, null)).toHaveLength(4);
  });

  it("returns sections strictly newer than sinceVersion", () => {
    const result = sectionsSince(fourSections, "0.2.0");
    expect(result.map((s) => s.version)).toEqual(["0.4.0", "0.3.0"]);
  });

  it("excludes the exact sinceVersion (strictly newer only)", () => {
    const result = sectionsSince(fourSections, "0.3.0");
    expect(result.map((s) => s.version)).toEqual(["0.4.0"]);
  });

  it("returns empty array when sinceVersion equals newest", () => {
    expect(sectionsSince(fourSections, "0.4.0")).toHaveLength(0);
  });

  it("handles multi-jump (user skipped 0.1.0 -> 0.4.0)", () => {
    const result = sectionsSince(fourSections, "0.1.0");
    expect(result.map((s) => s.version)).toEqual(["0.4.0", "0.3.0", "0.2.0"]);
  });

  it("returns all sections when sinceVersion is empty string", () => {
    expect(sectionsSince(fourSections, "")).toHaveLength(4);
  });

  it("returns empty array when sections are empty", () => {
    expect(sectionsSince([], "0.2.0")).toHaveLength(0);
  });

  it("returns empty for unknown stored version newer than all sections", () => {
    expect(sectionsSince(fourSections, "9.9.9")).toHaveLength(0);
  });

  it("returns all for unknown old stored version", () => {
    expect(sectionsSince(fourSections, "0.0.0")).toHaveLength(4);
  });
});
