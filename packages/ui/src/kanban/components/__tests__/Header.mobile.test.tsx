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
});
