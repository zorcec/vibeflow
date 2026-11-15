import { describe, expect, it } from "vitest";
import { cn } from "../cn";

describe("cn (P4 primitives)", () => {
  it("resolves conflicting Tailwind classes, later wins", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("keeps non-conflicting classes in order", () => {
    expect(cn("px-4", "py-2")).toBe("px-4 py-2");
  });

  it("supports conditional inputs", () => {
    expect(cn("btn", false && "hidden", undefined, null, "active")).toBe(
      "btn active",
    );
    expect(cn("btn", { active: true, disabled: false })).toBe("btn active");
    const big = true;
    expect(cn("btn", big ? "text-lg" : "text-sm")).toBe("btn text-lg");
  });
});
