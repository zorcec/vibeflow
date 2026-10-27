import { describe, expect, it } from "vitest";
import { resolveResponsiveView } from "../viewState";

describe("resolveResponsiveView", () => {
  it("defaults narrow viewports to list without changing desktop preference", () => {
    expect(resolveResponsiveView("board", 360)).toBe("list");
    expect(resolveResponsiveView("compact", 767)).toBe("list");
    expect(resolveResponsiveView("board", 768)).toBe("board");
  });

  it("honors mobile session selection and restores saved desktop view", () => {
    expect(resolveResponsiveView("board", 390, "compact")).toBe("compact");
    expect(resolveResponsiveView("board", 1280, "compact")).toBe("board");
    expect(resolveResponsiveView("compact", 360)).toBe("list");
  });
});
