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
 * of the values can never shrink the contract. Reads the stylesheet that
 * actually ships. Fails against the rotated mapping (todo wore backlog's
 * gray, in-progress wore todo's orange, review wore in-progress's blue).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The stylesheet that actually ships.
const CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../kanban.css"),
  "utf-8",
);

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

/** Extract the declaration block for `.status-badge--<status>` from the CSS. */
function badgeBlock(status: string): string {
  const re = new RegExp(
    `\\.status-badge--${status.replace("-", "\\-")}\\s*\\{([^}]*)\\}`,
  );
  const m = CSS.match(re);
  if (!m) throw new Error(`missing .status-badge--${status} rule in kanban.css`);
  return m[1];
}

/** Value of a single `prop:` declaration inside a block. */
function decl(block: string, prop: string): string {
  const m = block.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`));
  if (!m) throw new Error(`missing ${prop} declaration`);
  return m[1].trim();
}

describe("status badge colours match the kanban columns (b76059b2)", () => {
  for (const status of Object.keys(EXPECTED_TEXT)) {
    it(`${status} badge text carries the canonical hue`, () => {
      expect(decl(badgeBlock(status), "color")).toBe(EXPECTED_TEXT[status]);
    });

    it(`${status} badge tint carries the canonical hue`, () => {
      expect(decl(badgeBlock(status), "background")).toContain(
        EXPECTED_BG_RGB[status],
      );
    });
  }

  it("no two statuses share the same badge text colour", () => {
    const colors = Object.keys(EXPECTED_TEXT).map((s) =>
      decl(badgeBlock(s), "color"),
    );
    expect(new Set(colors).size).toBe(colors.length);
  });
});
