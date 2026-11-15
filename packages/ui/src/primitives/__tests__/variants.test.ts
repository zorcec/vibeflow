import { describe, expect, it } from "vitest";
import { cva } from "../variants";

const button = cva("btn", {
  variants: {
    size: { sm: "text-sm", lg: "text-lg" },
    tone: { plain: "tone-plain", accent: "tone-accent" },
  },
  defaultVariants: { size: "sm", tone: "plain" },
});

describe("variants (P4 primitives)", () => {
  it("resolves defaultVariants when no props are given", () => {
    expect(button()).toBe("btn text-sm tone-plain");
  });

  it("resolves an explicit variant over its default", () => {
    expect(button({ size: "lg" })).toBe("btn text-lg tone-plain");
    expect(button({ size: "lg", tone: "accent" })).toBe(
      "btn text-lg tone-accent",
    );
  });

  it("merges an extra className last", () => {
    expect(button({ className: "extra" })).toBe("btn text-sm tone-plain extra");
  });
});
