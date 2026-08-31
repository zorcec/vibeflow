import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const readChangelogContent = vi.fn<[], string | null>();

vi.mock("../../../src/core/changelog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/changelog.js")>();
  return {
    ...actual,
    readChangelogContent: () => readChangelogContent(),
  };
});

import { showChangelog } from "../../../src/commands/changelog.js";

const SAMPLE = `# Changelog

## 0.2.0

### Minor Changes

- abc1234: New feature

## 0.1.0

### Patch Changes

- def5678: Old fix
`;

describe("showChangelog", () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readChangelogContent.mockReset();
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
  });

  const output = () =>
    (log.mock.calls as unknown[][])
      .map((c) => String(c[0] ?? ""))
      .join("\n")
      .replace(/\u001b\[\d+m/g, "");

  it("prints the latest version section by default", () => {
    readChangelogContent.mockReturnValue(SAMPLE);
    showChangelog({});
    expect(output()).toContain("What's new in 0.2.0");
    expect(output()).toContain("New feature");
    expect(output()).not.toContain("Old fix");
  });

  it("hints at --all when showing only the latest version", () => {
    readChangelogContent.mockReturnValue(SAMPLE);
    showChangelog({});
    expect(output()).toContain("vibeflow changelog --all");
  });

  it("prints every version with --all and omits the hint", () => {
    readChangelogContent.mockReturnValue(SAMPLE);
    showChangelog({ all: true });
    const out = output();
    expect(out).toContain("What's new in 0.2.0");
    expect(out).toContain("What's new in 0.1.0");
    expect(out).not.toContain("--all");
  });

  it("reports gracefully when no changelog file exists", () => {
    readChangelogContent.mockReturnValue(null);
    showChangelog({});
    expect(output()).toContain("No changelog found");
  });

  it("reports gracefully when the changelog has no version headers", () => {
    readChangelogContent.mockReturnValue("# Changelog\n\nnothing yet\n");
    showChangelog({ all: true });
    expect(output()).toContain("No changelog found");
  });
});
