import { describe, it, expect } from "vitest";
import { classifyForDropIntent } from "../task-links";

/** Minimal wrapper stand-in: `classifyForDropIntent` reads the article rect
 *  and looks for the drag-only drop slot inside it, so the fakes need
 *  `querySelector` on both levels. */
function cardWrapper(top: number, height: number): HTMLElement {
  const article = {
    querySelector: () => null,
    getBoundingClientRect: () => ({ top, height, bottom: top + height }),
  };
  return {
    querySelector: (selector: string) =>
      selector === "article" ? article : null,
  } as unknown as HTMLElement;
}

/** Card whose make-child drop slot is rendered inside the article — the state
 *  of every childless card while a drag is active. The slot is the article's
 *  last in-flow child, so it hangs below the card content: `slotTop` marks
 *  where the content ends and the slot begins, and the article keeps
 *  `trailingPx` of its own padding/margin below the slot. */
function cardWrapperWithDropSlot(
  top: number,
  contentHeight: number,
  slotHeight: number,
  trailingPx = 0,
): HTMLElement {
  const slotTop = top + contentHeight;
  const slot = {
    getBoundingClientRect: () => ({
      top: slotTop,
      height: slotHeight,
      bottom: slotTop + slotHeight,
    }),
  };
  const articleHeight = contentHeight + slotHeight + trailingPx;
  const article = {
    querySelector: (selector: string) =>
      selector === '[data-role="empty-child-slot"]' ? slot : null,
    getBoundingClientRect: () => ({
      top,
      height: articleHeight,
      bottom: top + articleHeight,
    }),
  };
  return {
    querySelector: (selector: string) =>
      selector === "article" ? article : null,
  } as unknown as HTMLElement;
}

const TOP = 100;
const HEIGHT = 120;
// band = max(32, min(56, floor(120 * 0.28))) = 33
const BAND = 33;

describe("classifyForDropIntent — the make-child pill must not pin the whole card", () => {
  it("classifies an edge dragover by position while the pill is visible", () => {
    const wrapper = cardWrapper(TOP, HEIGHT);
    expect(classifyForDropIntent(wrapper, TOP + 4, true).zone).toBe("top");
    expect(classifyForDropIntent(wrapper, TOP + HEIGHT - 4, true).zone).toBe(
      "bottom",
    );
  });

  it("still pins a cursor that is actually over the pill (below the article)", () => {
    const wrapper = cardWrapper(TOP, HEIGHT);
    expect(classifyForDropIntent(wrapper, TOP + HEIGHT + 8, true).zone).toBe(
      "center",
    );
  });

  it("classifies the card centre as center with and without the pill", () => {
    const wrapper = cardWrapper(TOP, HEIGHT);
    expect(classifyForDropIntent(wrapper, TOP + HEIGHT / 2, false).zone).toBe(
      "center",
    );
    expect(classifyForDropIntent(wrapper, TOP + HEIGHT / 2, true).zone).toBe(
      "center",
    );
  });

  it("keeps the edge band boundaries independent of the pill", () => {
    const wrapper = cardWrapper(TOP, HEIGHT);
    expect(classifyForDropIntent(wrapper, TOP + BAND - 1, true).zone).toBe(
      "top",
    );
    expect(classifyForDropIntent(wrapper, TOP + BAND, true).zone).toBe(
      "center",
    );
    expect(
      classifyForDropIntent(wrapper, TOP + HEIGHT - BAND + 1, true).zone,
    ).toBe("bottom");
  });
});

// Geometry measured from a real board during a drag: the card content is
// 56px, the drop slot 24px below it, and the article keeps 4px below that.
// band = max(32, min(56, floor(56 * 0.28))) = 32, capped so a 10px centre
// survives → 23px per edge over the 56px of content.
const SLOT_TOP = 250;
const CONTENT_HEIGHT = 56;
const SLOT_HEIGHT = 24;
// centre zone: 273..283 — top band 250..273, bottom band 283..306
const SLOT_CENTRE_Y = SLOT_TOP + CONTENT_HEIGHT + 10;

describe("classifyForDropIntent — the drop slot must not swallow the 'after' band", () => {
  it("classifies a cursor just above the drop slot as bottom (drop after)", () => {
    // Regression: the article rect included the drag-only drop slot, so the
    // bottom band started below the card content and a drag aimed at the lower
    // part of a card could only ever resolve to make-child.
    const wrapper = cardWrapperWithDropSlot(
      SLOT_TOP,
      CONTENT_HEIGHT,
      SLOT_HEIGHT,
      4,
    );
    expect(classifyForDropIntent(wrapper, 300, false).zone).toBe("bottom");
    expect(
      classifyForDropIntent(wrapper, SLOT_TOP + CONTENT_HEIGHT - 1, false).zone,
    ).toBe("bottom");
  });

  it("classifies a cursor on the drop slot itself as center (make-child)", () => {
    const wrapper = cardWrapperWithDropSlot(
      SLOT_TOP,
      CONTENT_HEIGHT,
      SLOT_HEIGHT,
      4,
    );
    expect(classifyForDropIntent(wrapper, SLOT_CENTRE_Y, false).zone).toBe(
      "center",
    );
  });

  it("keeps the top band and the centre zone reachable with the slot present", () => {
    const wrapper = cardWrapperWithDropSlot(
      SLOT_TOP,
      CONTENT_HEIGHT,
      SLOT_HEIGHT,
      4,
    );
    expect(classifyForDropIntent(wrapper, SLOT_TOP + 4, false).zone).toBe("top");
    expect(classifyForDropIntent(wrapper, SLOT_TOP + 30, false).zone).toBe(
      "center",
    );
  });

  it("returns the slot-excluded content rect to callers", () => {
    const wrapper = cardWrapperWithDropSlot(
      SLOT_TOP,
      CONTENT_HEIGHT,
      SLOT_HEIGHT,
      4,
    );
    const { rect } = classifyForDropIntent(wrapper, SLOT_CENTRE_Y, false);
    expect(rect.top).toBe(SLOT_TOP);
    expect(rect.height).toBe(CONTENT_HEIGHT);
  });

  it("classifies exactly as before when no slot is rendered", () => {
    const withSlot = cardWrapperWithDropSlot(
      SLOT_TOP,
      CONTENT_HEIGHT,
      SLOT_HEIGHT,
      4,
    );
    const bare = cardWrapper(SLOT_TOP, CONTENT_HEIGHT);
    for (const y of [
      SLOT_TOP + 4,
      SLOT_TOP + 30,
      SLOT_TOP + CONTENT_HEIGHT - 6,
    ]) {
      expect(classifyForDropIntent(withSlot, y, false).zone).toBe(
        classifyForDropIntent(bare, y, false).zone,
      );
    }
  });
});

describe("classifyForDropIntent — short cards keep a reachable centre zone", () => {
  it("classifies centre/edges of 40–64px cards", () => {
    for (const height of [40, 48, 56, 64]) {
      const wrapper = cardWrapper(TOP, height);
      expect(classifyForDropIntent(wrapper, TOP + height / 2, false).zone).toBe(
        "center",
      );
      expect(classifyForDropIntent(wrapper, TOP + 2, false).zone).toBe("top");
      expect(classifyForDropIntent(wrapper, TOP + height - 2, false).zone).toBe(
        "bottom",
      );
    }
  });
});
