import { describe, expect, it } from "vitest";
import {
  resolveMobileOverrideAfterResize,
  resolveResponsiveView,
} from "../viewState";

/**
 * MOBILE-KANBAN M1 (ticket k2x2agpos66jpsggi1owj1er): at <=767px the board
 * is the ONLY view — list and compact are removed on phones, and the view
 * toggle is hidden there (kanban.css narrow block), so nothing can select
 * them. These assertions are the contract both hosts inherit through
 * `resolveResponsiveView` (hosted `hostedViewForViewport` delegates here).
 */
describe("resolveResponsiveView", () => {
  it("phones are kanban-only: every narrow width resolves to board", () => {
    expect(resolveResponsiveView("board", 360)).toBe("board");
    expect(resolveResponsiveView("list", 360)).toBe("board");
    expect(resolveResponsiveView("compact", 390)).toBe("board");
    expect(resolveResponsiveView("list", 767)).toBe("board");
  });

  it("a stale mobile override cannot re-introduce list or compact on a phone", () => {
    // Hosts still pass the third argument (their session state may hold an
    // override from before M1); a phone must ignore it.
    expect(resolveResponsiveView("compact", 390, "list")).toBe("board");
    expect(resolveResponsiveView("board", 390, "compact")).toBe("board");
    expect(resolveResponsiveView("list", 360, "list")).toBe("board");
  });

  it("desktop keeps the saved view exactly as before", () => {
    expect(resolveResponsiveView("board", 768)).toBe("board");
    expect(resolveResponsiveView("compact", 768)).toBe("compact");
    expect(resolveResponsiveView("list", 1280)).toBe("list");
    // The saved desktop choice wins on desktop even with an override set.
    expect(resolveResponsiveView("compact", 1280, "list")).toBe("compact");
  });

  it("still clears a mobile override when the viewport crosses to desktop", () => {
    // `resolveResponsiveView` ignores the override on phones now, but both
    // hosts keep calling this on resize to drop stale session state — pin
    // that the API behaves as they expect.
    expect(resolveMobileOverrideAfterResize(390, 1280, "board")).toBeNull();
    expect(resolveMobileOverrideAfterResize(390, 767, "board")).toBe("board");
    expect(resolveMobileOverrideAfterResize(1280, 390, "list")).toBe("list");
  });
});
