import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ticket 2aefa368 — "Tasks jump on hover".
 *
 * The card once lifted itself with `transform: translateY(-1px)` on
 * `:hover`: a 1px jump on every hover. Hover affordance is border +
 * background + shadow only, so this test pins the `.task-card:hover`
 * rule to never declare a box-moving property again (transform,
 * translate, margin, padding, border-width, position).
 */
const cssPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../kanban.css",
);

function hoverBlock(): string {
  const css = readFileSync(cssPath, "utf-8");
  const match = css.match(/\.task-card:hover\s*\{([^}]*)\}/);
  expect(match, ".task-card:hover rule must exist in kanban.css").toBeTruthy();
  return match![1];
}

describe("TaskCard hover stability (2aefa368)", () => {
  it("keeps its hover affordance (border + background + shadow)", () => {
    const block = hoverBlock();
    expect(block).toMatch(/border-color/);
    expect(block).toMatch(/background/);
    expect(block).toMatch(/box-shadow/);
  });

  it("declares no box-moving property on :hover", () => {
    const declared = hoverBlock()
      .split(";")
      .map((decl) => decl.split(":")[0].trim().toLowerCase())
      .filter(Boolean);
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
