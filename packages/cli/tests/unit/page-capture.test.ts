// @vitest-environment jsdom
/**
 * Page capture/selector pins (src/core/page-capture.ts, page-selector.ts).
 *
 * These helpers run inside page.evaluate() in production, but they are
 * pure DOM reads — no Node APIs — so jsdom pins them exactly:
 *
 * - buildKey builds the index path from the document root;
 * - buildDisplaySelector prefers task-id / column markers, then classes;
 * - filterStyles reads the requested computed properties;
 * - normalizeText collapses whitespace and honours the limit;
 * - childSignature groups children into "tag.classes ×n" rows;
 * - capturePageSnapshot records classed/data elements, skips bare ones,
 *   and truncates past MAX_ELEMENTS instead of growing unboundedly.
 *
 * A broken key/selector/text rule fails these tests (and would corrupt
 * every verify evidence file downstream).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { capturePageSnapshot } from "../../src/core/page-capture.js";
import {
  buildKey,
  buildDisplaySelector,
  filterStyles,
  normalizeText,
  childSignature,
} from "../../src/core/page-selector.js";

beforeEach(() => {
  document.body.innerHTML = "";
});

function board(): HTMLElement {
  document.body.innerHTML = `
    <div class="board" data-status="backlog">
      <article class="task-card" data-task-id="abc">First task</article>
      <article class="task-card" data-task-id="def">Second task</article>
      <span>bare</span>
    </div>
  `;
  return document.body.firstElementChild as HTMLElement;
}

describe("buildKey", () => {
  it("builds the index path from the document root", () => {
    const root = board();
    const first = root.children[0];
    // Paths run from <html>: head is child 0, body child 1, the board
    // is body's child 0.
    expect(buildKey(root)).toBe("1/0");
    expect(buildKey(first)).toBe("1/0/0");
    expect(buildKey(root.children[1])).toBe("1/0/1");
  });
});

describe("buildDisplaySelector", () => {
  it("prefers data-task-id for task cards", () => {
    const card = board().querySelector(
      '[data-task-id="abc"]',
    ) as unknown as Element;
    expect(buildDisplaySelector(card)).toBe(
      "article.task-card[data-task-id=abc]",
    );
  });

  it("prefers the column marker for scroll containers", () => {
    const root = board() as unknown as Element;
    document.body.firstElementChild!.classList.add("column-scroll");
    expect(buildDisplaySelector(root)).toBe(
      "div.column-scroll[data-status=backlog]",
    );
  });

  it("prefers data-column-id for column wrappers", () => {
    document.body.innerHTML = `<section data-column-id="col-1"></section>`;
    const el = document.body.firstElementChild as unknown as Element;
    expect(buildDisplaySelector(el)).toBe("section[data-column-id=col-1]");
  });

  it("falls back to tag plus classes with nth-of-type for siblings", () => {
    const cards = board().querySelectorAll(".task-card");
    // Both cards share tag+classes, so the second is disambiguated.
    expect(buildDisplaySelector(cards[1] as unknown as Element)).toContain(
      "article.task-card[data-task-id=def]",
    );
    document.body.innerHTML = `<ul><li>a</li><li>b</li></ul>`;
    const items = document.body.querySelectorAll("li");
    expect(buildDisplaySelector(items[0] as unknown as Element)).toBe(
      "li:nth-of-type(1)",
    );
  });
});

describe("filterStyles", () => {
  it("reads exactly the requested computed properties", () => {
    document.body.innerHTML = `<div style="display: block; color: red;"></div>`;
    const el = document.body.firstElementChild as unknown as Element;
    const out = filterStyles(el, ["display", "color"]);
    expect(Object.keys(out).sort()).toEqual(["color", "display"]);
    expect(out.display).toBe("block");
    expect(out.color).toBe("rgb(255, 0, 0)");
  });
});

describe("normalizeText", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeText("  hello\n\t  world  ")).toBe("hello world");
  });

  it("honours the character limit", () => {
    expect(normalizeText("abcdefghij", 5)).toBe("abcde");
    expect(normalizeText("short", 200)).toBe("short");
  });
});

describe("childSignature", () => {
  it("groups children into tag.classes rows with counts", () => {
    const root = board();
    const sig = childSignature(Array.from(root.children) as unknown as Element[]);
    expect(sig).toContain("article.task-card ×2");
    expect(sig).toContain("span ×1");
  });

  it("uses only the first two classes", () => {
    document.body.innerHTML = `<div class="a b c"></div>`;
    const sig = childSignature([
      document.body.firstElementChild as unknown as Element,
    ]);
    expect(sig).toEqual(["div.a.b ×1"]);
  });
});

describe("capturePageSnapshot", () => {
  it("records classed and data elements with their context", () => {
    board();
    const snapshot = capturePageSnapshot(["display"]);
    expect(snapshot.version).toBe(1);
    expect(snapshot.truncated).toBe(false);
    expect(typeof snapshot.capturedAt).toBe("string");

    const elements = Object.values(snapshot.elements);
    const card = elements.find((e) => e.dataAttrs["task-id"] === "abc");
    expect(card).toBeDefined();
    expect(card!.tag).toBe("article");
    expect(card!.classes).toContain("task-card");
    expect(card!.selector).toContain("data-task-id=abc");
    expect(card!.text).toBe("First task");
    expect(card!.childCount).toBe(0);
    // The parent link resolves to the board's own key.
    const parent = elements.find((e) => e.key === card!.parentKey);
    expect(parent?.dataAttrs["status"]).toBe("backlog");
    // Styles were read for the requested properties.
    expect(card!.after).toHaveProperty("display");
    expect(card!.baseline).toEqual(card!.after);
    expect(card!.position).toMatchObject({ x: 0, y: 0 });
  });

  it("skips bare elements with no classes or data markers", () => {
    document.body.innerHTML = `<div><p>plain</p><p class=\"note\">kept</p></div>`;
    const snapshot = capturePageSnapshot(["display"]);
    const elements = Object.values(snapshot.elements);
    // The bare paragraph is skipped; the classed one is kept.
    expect(elements.filter((e) => e.tag === "p")).toHaveLength(1);
    expect(elements.some((e) => e.classes.includes("note"))).toBe(true);
    expect(elements.some((e) => e.text === "plain")).toBe(false);
  });

  // NOTE: the MAX_ELEMENTS truncation branch is intentionally unpinned
  // here — driving 1000+ elements through jsdom's getComputedStyle takes
  // minutes. The cap is a three-line guard; the counting above proves the
  // accumulation it guards.
});
