import { describe, expect, it } from "vitest";
import {
  resolveMobileOverrideAfterResize,
  resolveResponsiveView,
} from "../viewState";

describe("resolveResponsiveView", () => {
  it("defaults narrow viewports to list without changing desktop preference", () => {
    expect(resolveResponsiveView("board", 360)).toBe("list");
    expect(resolveResponsiveView("compact", 767)).toBe("list");
    expect(resolveResponsiveView("board", 768)).toBe("board");
  });

  it("clears a mobile selection when crossing to desktop but retains it within mobile", () => {
    const selected = "board" as const;
    expect(resolveMobileOverrideAfterResize(390, 1280, selected)).toBeNull();
    expect(resolveMobileOverrideAfterResize(390, 767, selected)).toBe(selected);
    expect(resolveResponsiveView("compact", 390, selected)).toBe("board");
    expect(resolveResponsiveView("compact", 390, null)).toBe("list");
    expect(resolveResponsiveView("compact", 1280, null)).toBe("compact");
  });

  it("honors mobile session selection and restores saved desktop view", () => {
    expect(resolveResponsiveView("board", 390, "compact")).toBe("compact");
    expect(resolveResponsiveView("board", 1280, "compact")).toBe("board");
    expect(resolveResponsiveView("compact", 360)).toBe("list");
  });
});
