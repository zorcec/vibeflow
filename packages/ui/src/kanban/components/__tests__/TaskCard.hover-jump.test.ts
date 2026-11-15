import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "@testing-library/react";
import { TaskCard } from "../TaskCard";
import type { Task, Column } from "../../types";

/**
 * Ticket 2aefa368 — "Tasks jump on hover".
 *
 * The card once lifted itself with `transform: translateY(-1px)` on
 * `:hover`: a 1px jump on every hover. Hover affordance is border +
 * background + shadow only, so this test pins the `.task-card:hover`
 * rule to never declare a box-moving property again (transform,
 * translate, margin, padding, border-width, position).
 *
 * PORTED (P13.1): the assertions no longer read `kanban.css` as file
 * text. The stylesheet is injected into the rendered document and the
 * hover block is read back through the CSSOM — a `CSSStyleRule` parsed
 * by the browser's own CSS parser — while the card itself is rendered
 * and measured with `getComputedStyle`. jsdom cannot activate the
 * `:hover` state on an element, so the hover block itself is a parsed
 * rule rather than a computed value; everything that CAN be computed
 * (the card's rest state, the sheet actually cascading to the element)
 * is computed. A regex over source text could pass on a rule the
 * browser failed to parse; this cannot.
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

/** Every parsed style rule in the injected sheet, recursing into media/supports. */
function allStyleRules(): CSSStyleRule[] {
  const out: CSSStyleRule[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) out.push(rule);
      else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
        walk(rule.cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
  return out;
}

/**
 * The `.task-card:hover` rule itself — matched as a whole selector in
 * the selector list, so descendant reveals (`.task-card:hover .child…`)
 * never satisfy it.
 */
function hoverBlock(): CSSStyleRule {
  const match = allStyleRules().find((rule) =>
    rule.selectorText
      .split(",")
      .map((s) => s.trim())
      .includes(".task-card:hover"),
  );
  expect(match, ".task-card:hover rule must exist in the stylesheet").toBeTruthy();
  return match!;
}

function renderCard() {
  const task: Task = { id: "hover-task", title: "Hover me", status: "todo" };
  const col: Column = { id: "todo", label: "Todo", color: "#888", accent: "#888" };
  // createElement, not JSX: this file keeps its .ts path (P13.1 port).
  return render(
    React.createElement(TaskCard, {
      task,
      col,
      allTasks: [task],
      onOpen: () => {},
      onDragStart: () => {},
    }),
  );
}

describe("TaskCard hover stability (2aefa368)", () => {
  it("keeps its hover affordance (border + background + shadow)", () => {
    const decls = hoverBlock().style;
    expect(decls.getPropertyValue("border-color")).not.toBe("");
    expect(decls.getPropertyValue("background")).not.toBe("");
    expect(decls.getPropertyValue("box-shadow")).not.toBe("");
    // The sheet really cascades to the rendered card (computed, not text):
    // border-radius and cursor come ONLY from the `.task-card` rule (the
    // component's inline style sets neither), and the card never carries a
    // transform at rest. The card's own background is an inline token value,
    // so it is deliberately not asserted here.
    const { container } = renderCard();
    const card = container.querySelector("article.task-card");
    expect(card).not.toBeNull();
    const cs = getComputedStyle(card!);
    expect(cs.borderRadius).toBe("10px");
    expect(cs.cursor).toBe("grab");
    expect(cs.transform).toBe("none");
  });

  it("declares no box-moving property on :hover", () => {
    const style = hoverBlock().style;
    const declared: string[] = [];
    for (let i = 0; i < style.length; i++) {
      declared.push(style.item(i).toLowerCase());
    }
    for (const prop of [
      "transform",
      "translate",
      "margin",
      "margin-top",
      "padding",
      "border-width",
      "position",
      "top",
      "left",
    ]) {
      expect(
        declared,
        `.task-card:hover must not declare ${prop}`,
      ).not.toContain(prop);
    }
  });
});
