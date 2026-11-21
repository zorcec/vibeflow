import { describe, expect, it } from "vitest";
import {
  resolveMobileOverrideAfterResize,
  resolveResponsiveView,
} from "../viewState";

/**
 * Owner order (2026-11-21, ticket 6e927e14908f0cc28c89106657b0bd): kanban is
 * the ONLY view product-wide, at every width — list and compact are gone, and
 * so is the view toggle that could select them. These assertions are the
 * contract both hosts inherit through `resolveResponsiveView` (hosted
 * `hostedViewForViewport` delegates here): a saved `list`/`compact` preference
 * and a stale mobile override both resolve to board with no migration.
 */
describe("resolveResponsiveView", () => {
  it("every width resolves to the board, whatever the saved view says", () => {
    for (const width of [360, 390, 767, 768, 1024, 1280]) {
      expect(resolveResponsiveView("board", width)).toBe("board");
      expect(resolveResponsiveView("list", width)).toBe("board");
      expect(resolveResponsiveView("compact", width)).toBe("board");
    }
  });

  it("ignores a stale override, so no session state can bring list/compact back", () => {
    // Hosts still pass the third argument (their session state may hold an
    // override from before this order); it can never win.
    expect(resolveResponsiveView("compact", 390, "list")).toBe("board");
    expect(resolveResponsiveView("board", 1280, "compact")).toBe("board");
    expect(resolveResponsiveView("list", 360, "list")).toBe("board");
    expect(resolveResponsiveView("list", 1280, "list")).toBe("board");
  });

  it("still clears a mobile override when the viewport crosses to desktop", () => {
    // `resolveResponsiveView` ignores the override everywhere now, but both
    // hosts keep calling this on resize to drop stale session state — pin
    // that the API behaves as they expect.
    expect(resolveMobileOverrideAfterResize(390, 1280, "board")).toBeNull();
    expect(resolveMobileOverrideAfterResize(390, 767, "board")).toBe("board");
    expect(resolveMobileOverrideAfterResize(1280, 390, "list")).toBe("list");
  });
});
