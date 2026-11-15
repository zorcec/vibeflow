import { describe, expect, it } from "vitest";

/**
 * The package entry is a public surface, so it is tested like one.
 *
 * `index.ts` is a re-export-only module: nothing inside the package imports it,
 * so without this file it sits at 0% coverage and drags the design-system gate
 * down. Excluding it would hide a real risk — an export silently disappearing
 * from the public surface between releases — so it is asserted instead.
 */
import * as entry from "../index";

describe("primitives entry (public surface)", () => {
  it("exports the class helpers every primitive is built on", () => {
    expect(typeof entry.cn).toBe("function");
    expect(typeof entry.cva).toBe("function");
  });

  it("cn still merges conflicting utilities through the entry", () => {
    expect(entry.cn("px-2", "px-4")).toBe("px-4");
  });

  it("cva still resolves variants through the entry", () => {
    const button = entry.cva("base", {
      variants: { tone: { quiet: "text-muted", loud: "text-bold" } },
      defaultVariants: { tone: "quiet" },
    });
    expect(button()).toBe("base text-muted");
    expect(button({ tone: "loud" })).toBe("base text-bold");
  });
});
