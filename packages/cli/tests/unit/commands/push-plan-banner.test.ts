/**
 * The push plan banner: which transport runs, and how the work is split.
 *
 * Push has two transports and only one is fast. When the archive path is
 * unavailable the CLI degrades to legacy batches (100 tasks / 50 files per
 * request) and NOTHING said so: the archive path prints no per-chunk progress,
 * the legacy one does, so the only signal was a counter appearing that the user
 * had never seen. Watching 1800 tasks crawl in 100-task steps gave no way to
 * tell whether the archive was off, or why. This line is the answer, printed
 * before anything is sent.
 */
import { describe, expect, it } from "vitest";

import { formatPushPlanBanner } from "../../../src/commands/push.js";

describe("formatPushPlanBanner", () => {
  it("names the archive transport and the split", () => {
    const line = formatPushPlanBanner("archive", 1788, 9);
    expect(line).toContain("1788 task(s)");
    expect(line).toContain("9 archives");
    // The point of the archive: files and comments are not a second phase.
    expect(line).toContain("files and comments");
  });

  it("says why the legacy path is slower", () => {
    const line = formatPushPlanBanner("legacy", 1788, 18);
    expect(line).toContain("18 batches");
    expect(line).toContain("legacy path");
    // The two numbers that make the difference visible to a user watching it.
    expect(line).toContain("100 tasks");
    expect(line).toContain("50 files");
  });

  it("uses the singular when a single request carries everything", () => {
    expect(formatPushPlanBanner("archive", 3, 1)).toContain("1 archive ");
    expect(formatPushPlanBanner("legacy", 3, 1)).toContain("1 batch ");
  });
});
