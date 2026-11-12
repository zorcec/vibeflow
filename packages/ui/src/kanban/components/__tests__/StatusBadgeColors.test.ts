/**
 * Status badge colours — every status LABEL must read the same colour as the
 * board column for that status (b76059b2).
 *
 * Canonical map: backlog gray, todo orange, in-progress blue, review purple,
 * done green (STATUS_COLORS in ../../task-links.ts → --t-status-* vars).
 * The badge rules below mirror the DetailPanel dp-status-btn.active-*
 * text colours and the FilterBar/ListView chip convention:
 * backlog slate / todo amber / in-progress blue / review purple / done green.
 *
 * The mapping is kept EXPLICIT (not derived from the CSS) so a re-rotation
 * of the values can never shrink the contract.
 *
 * PORTED (P13.1): no longer a regex over `kanban.css` file text. The
 * stylesheet that actually ships is injected into the rendered document and
 * the badge is RENDERED through `ChildRow` — the component that paints
 * `.status-badge--<status>` on the board — then measured with
 * `getComputedStyle`. The test now fails both when the rule's value is
 * wrong AND when the rule stops applying to the element (a text match
 * could not see the latter). jsdom returns `var(…)` token strings
 * unresolved, so the expected text colour IS the token literal — which is
 * exactly the contract the old test pinned.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "@testing-library/react";
import { ChildRow } from "../ChildRow";
import type { Task } from "../../types";

// The stylesheet that actually ships.
const CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../kanban.css"),
  "utf-8",
);

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
});

/** Expected badge text token per status — the chip tier that carries the
 * canonical hue in BOTH dark and light themes (light values are the darker
 * step of the same hue, still legible on white). */
const EXPECTED_TEXT: Record<string, string> = {
  backlog: "var(--t-chip-slate-400)",
  todo: "var(--t-chip-amber-300)",
  "in-progress": "var(--t-chip-blue-200)",
  review: "var(--t-chip-purple-300)",
  done: "var(--t-chip-green-400)",
};

/** Expected badge background tint per status — the exact rgb triple of the
 * canonical --t-status-* value at low alpha, so the tint carries the same
 * hue as the board column. */
const EXPECTED_BG_RGB: Record<string, string> = {
  backlog: "148, 163, 184", // #94a3b8 --t-status-backlog
  todo: "245, 158, 11", // #f59e0b --t-status-todo
  "in-progress": "96, 165, 250", // #60a5fa --t-status-progress
  review: "168, 85, 247", // #a855f7 --t-status-review
  done: "74, 222, 128", // #4ade80 ≈ --t-status-done #22c55e tint family
};

/**
 * Render the shipped badge for a status through ChildRow (the component
 * that paints it on the board) and return its computed colours.
 */
function computedBadge(status: string): {
  color: string;
  backgroundColor: string;
} {
  const child: Task = { id: `t-${status}`, title: "Nested child", status: status as Task["status"] };
  const { container, unmount } = render(
    React.createElement(ChildRow, { child, variant: "inline" }),
  );
  const badge = container.querySelector<HTMLElement>(
    `.status-badge--${status}`,
  );
  if (!badge) {
    unmount();
    throw new Error(`missing rendered .status-badge--${status} element`);
  }
  const cs = getComputedStyle(badge);
  const result = { color: cs.color, backgroundColor: cs.backgroundColor };
  unmount();
  return result;
}

describe("status badge colours match the kanban columns (b76059b2)", () => {
  for (const status of Object.keys(EXPECTED_TEXT)) {
    it(`${status} badge text carries the canonical hue`, () => {
      expect(computedBadge(status).color).toBe(EXPECTED_TEXT[status]);
    });

    it(`${status} badge tint carries the canonical hue`, () => {
      expect(computedBadge(status).backgroundColor).toContain(
        EXPECTED_BG_RGB[status],
      );
    });
  }

  it("no two statuses share the same badge text colour", () => {
    const colors = Object.keys(EXPECTED_TEXT).map(
      (s) => computedBadge(s).color,
    );
    expect(new Set(colors).size).toBe(colors.length);
  });
});
