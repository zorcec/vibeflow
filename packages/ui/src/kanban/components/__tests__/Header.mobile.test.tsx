import React from "react";
import { describe, expect, it, vi, beforeAll } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Header } from "../Header";
import { FilterBar } from "../FilterBar";

/**
 * Shared mobile header and filter reflow.
 *
 * PORTED (P13.2): the two stylesheet-text assertions (`css` regexed as file
 * text) are gone. The shipped stylesheet is injected into the rendered
 * document, and every mobile-layout claim is now read back either as a
 * PARSED rule from the live CSSOM — a `CSSMediaRule`/`CSSStyleRule` produced
 * by the browser's own parser, so source text the parser rejects can no
 * longer satisfy it — or as a COMPUTED value measured on the rendered
 * element. jsdom's viewport is a fixed 1024px, so declarations inside the
 * `max-width: 767px` block are asserted as parsed rules (the same split
 * P13.1 uses for the `@media (hover: hover)` gate), while the desktop-side
 * base rules that apply at any width are computed on the elements themselves.
 *
 * Side effect of loading the sheet: the menu trigger is now genuinely
 * `display: none` on desktop, and dom-accessibility-api computes the
 * accessible name of a hidden element as "", so role+name can no longer find
 * it (it passed before only because no stylesheet was loaded at all). The
 * port asserts the same contract — the exact aria hooks and the click that
 * opens the menu — plus the computed `display: none` the old test never saw.
 */
const cssPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../kanban.css",
);

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = readFileSync(cssPath, "utf-8");
  document.head.appendChild(style);
});

/** The parsed `@media (max-width: 767px)` narrow-viewport reflow block. */
function narrowMedia(): CSSMediaRule {
  const found: CSSMediaRule[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        if (/max-width:\s*767px/.test(rule.conditionText)) found.push(rule);
        walk(rule.cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
  expect(
    found,
    "the narrow-viewport reflow block @media (max-width: 767px) must exist",
  ).not.toEqual([]);
  return found[0];
}

/**
 * The parsed rule for one whole selector inside the narrow block — matched
 * as a member of the selector list, so descendant rules
 * (`.kb-filter-bar > div[…]`) never satisfy it.
 */
function ruleIn(media: CSSMediaRule, selector: string): CSSStyleRule {
  const match = Array.from(media.cssRules).find(
    (rule): rule is CSSStyleRule =>
      rule instanceof CSSStyleRule &&
      rule.selectorText.split(",").map((s) => s.trim()).includes(selector),
  );
  expect(
    match,
    `rule "${selector}" must live inside the narrow-viewport block`,
  ).toBeTruthy();
  return match!;
}

/** `flex: <grow> <shrink> <basis>` read back as it parsed (longhand or shorthand). */
function flexTriple(style: CSSStyleDeclaration): string {
  const shorthand = style.getPropertyValue("flex").trim();
  if (shorthand) return shorthand;
  return [
    style.getPropertyValue("flex-grow"),
    style.getPropertyValue("flex-shrink"),
    style.getPropertyValue("flex-basis"),
  ].join(" ");
}

function renderHeader() {
  return render(
    <Header
      projectName="A long mobile project title"
      searchQuery=""
      taskSummary="1 open"
      onSearchChange={vi.fn()}
      onSettings={vi.fn()}
      extraActions={<button id="overview-btn">Overview</button>}
    />,
  );
}

describe("shared mobile header and filter reflow", () => {
  it("keeps search and hidden header actions reachable from an accessible menu", () => {
    const view = renderHeader();
    expect(view.getByRole("textbox", { name: "Search tasks" })).toBeTruthy();

    // Desktop base rule: the trigger is hidden until the narrow viewport
    // reveals it — computed on the rendered element, not read as text.
    const trigger = view.container.querySelector<HTMLButtonElement>(
      ".kb-mobile-menu-trigger",
    );
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute("aria-label")).toBe("Open board menu");
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");
    expect(trigger!.getAttribute("aria-controls")).toBe("kb-header-actions-menu");
    expect(getComputedStyle(trigger!).display).toBe("none");

    fireEvent.click(trigger!);
    const menu = view.getByLabelText("Board actions");
    expect(menu).toBeTruthy();
    expect(menu.querySelector("#overview-btn")).toBeTruthy();
    expect(menu.querySelector("#btn-settings")).toBeTruthy();
    // The open menu is desktop-hidden too — its layout lives in the
    // narrow block, which flips it to a positioned flex menu.
    expect(getComputedStyle(menu).display).toBe("none");
    expect(ruleIn(narrowMedia(), ".kb-mobile-menu").style.display).toBe("flex");
  });

  it("keeps status, filter, and view controls in a wrapping narrow layout", () => {
    const view = render(
      <FilterBar
        tasks={[]}
        filter={{ status: "all", component: null, type: null, user: null, tags: [] }}
        onFilter={vi.fn()}
        view="list"
      />,
    );
    expect(view.getByTestId("filter-bar").className).toContain("kb-filter-bar");
    expect(view.getByRole("button", { name: "All" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Tags" })).toBeTruthy();
    expect(view.getByRole("button", { name: "User" })).toBeTruthy();
    // Desktop contract: the toggle still EXISTS in the DOM (>=768px keeps
    // all three views). That it is HIDDEN at <=767px — M1, kanban-only
    // phones — is pinned in the dedicated test below.
    expect(view.getByRole("button", { name: "Board view" })).toBeTruthy();

    // PORTED from stylesheet-text regexes to parsed CSSOM rules.
    const media = narrowMedia();
    expect(media.conditionText).toMatch(/max-width:\s*767px/);
    expect(
      ruleIn(media, ".kb-filter-bar").style.getPropertyValue("flex-wrap"),
      "the filter bar must wrap on narrow viewports",
    ).toBe("wrap");
    // The header half of the same reflow — the layout the old file-text
    // check could only imply.
    expect(
      ruleIn(media, ".kb-header").style.getPropertyValue("flex-wrap"),
      "the header must wrap on narrow viewports",
    ).toBe("wrap");
    const search = ruleIn(media, ".kb-header-search").style;
    expect(search.getPropertyValue("order")).toBe("3");
    expect(flexTriple(search)).toMatch(/1\s+0\s+100%/);
    expect(
      ruleIn(media, ".kb-header-desktop-actions").style.getPropertyValue("display"),
      "desktop header actions hide behind the menu on narrow viewports",
    ).toBe("none");
    expect(flexTriple(ruleIn(media, ".kb-status-filters").style)).toMatch(
      /1\s+0\s+100%/,
    );
  });

  /** The base (any-width) rule for one selector, outside every media block. */
  function baseRule(selector: string): CSSStyleRule {
    const found: CSSStyleRule[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (
          rule instanceof CSSStyleRule &&
          rule.parentRule === null &&
          rule.selectorText.split(",").map((s) => s.trim()).includes(selector)
        ) {
          found.push(rule);
        }
      }
    }
    expect(found, `base rule "${selector}" must exist`).not.toEqual([]);
    return found[0];
  }

  /**
   * MOBILE-KANBAN M1 (ticket k2x2agpos66jpsggi1owj1er): the phone header
   * carries the lane toggle and NOT the view toggle. The lane pill SLOT is
   * the Header's half of the contract (KanbanBoard portals the pills in —
   * the board half lives in KanbanBoard.mobile-lane.test.tsx); the
   * view-toggle disappearance is this file's half, since the old
   * "view controls on a phone" guard was exactly what M1 removed.
   */
  it("hosts the lane-toggle slot and drops the view toggle at <=767px", () => {
    const view = renderHeader();

    // Header owns the mount point the board portals into.
    const slot = view.container.querySelector("#kb-lane-pills");
    expect(slot, "the Header must render the lane-pill slot").not.toBeNull();
    expect(slot!.className).toBe("kb-lane-pills");
    expect(slot!.getAttribute("role")).toBe("group");
    expect(slot!.getAttribute("aria-label")).toBe("Switch lane");

    const media = narrowMedia();
    // Revealed only inside the narrow block, on its own wrapped header line
    // (order 4 — the search field owns order 3) …
    const slotRule = ruleIn(media, ".kb-lane-pills");
    expect(slotRule.style.display).toBe("flex");
    expect(slotRule.style.order).toBe("4");
    // … and hidden at every other width by the base rule, so a desktop
    // header can never show a stray pill row.
    expect(baseRule(".kb-lane-pills").style.display).toBe("none");

    // Kanban only: the view toggle (list/compact/board) is gone on phones.
    expect(ruleIn(media, ".kb-view-toggle").style.display).toBe("none");

    // The pills are primary controls, so they carry the block's audited
    // 44px tap-target floor — not the prototype's 36px.
    expect(ruleIn(media, ".kb-lane-pill").style.minHeight).toBe("44px");
  });
});
