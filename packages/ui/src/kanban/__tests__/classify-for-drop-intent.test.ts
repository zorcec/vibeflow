import { describe, it, expect } from "vitest";
import { classifyForDropIntent } from "../task-links";

/** Minimal wrapper stand-in: `classifyForDropIntent` only reads the article
 *  rect, so the fake needs just `querySelector("article")`. */
function cardWrapper(top: number, height: number): HTMLElement {
  const article = {
    getBoundingClientRect: () => ({ top, height, bottom: top + height }),
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
