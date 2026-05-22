import { describe, expect, it } from "vitest";
import { resolveTaskCardBorderColor } from "../../src/client/kanban/components/TaskCard.js";

describe("resolveTaskCardBorderColor", () => {
  it("uses status color with soft default alpha", () => {
    expect(resolveTaskCardBorderColor("#3b82f6")).toBe("#3b82f63d");
  });

  it("increases alpha for high and critical priority", () => {
    expect(resolveTaskCardBorderColor("#f59e0b", "High")).toBe("#f59e0b4d");
    expect(resolveTaskCardBorderColor("#ef4444", "Critical")).toBe("#ef44445c");
  });

  it("falls back when color is not a valid hex value", () => {
    expect(resolveTaskCardBorderColor("rgba(59,130,246,1)")).toBe(
      "color-mix(in srgb, var(--p-text-g) 40%, transparent)",
    );
  });
});
