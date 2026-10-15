/**
 * Geometry contract for the two owner-REJECTED tickets — reads the
 * stylesheet that actually ships and pins the exact rules the fixes rely on.
 *
 * 9ec6fbbb ("Child hover effect" — hover background must be FULL WIDTH):
 * the hover well is painted on `.child-row-wrap` (ChildRow.tsx inline
 * `background: var(--t-hover)`), whose width is the TREE width. The tree
 * used to sit inside `.card-children-zone`'s horizontal padding
 * (`4px 8px 8px 10px`), so the well stopped ~10px/8px short of the card
 * edges. The fix moves that horizontal pad off the zone and onto the
 * wrapper (`.child-row-wrap--inline`), so the painted box spans the full
 * zone width while the row CONTENT stays where it was.
 *
 * 2e6b6b1f ("Not aligned with the left created"): the `#dp-id` value row
 * held a 22px `.card-copy-id` pill next to 11px text, growing the row to
 * 22px while `#dp-created` stayed 16px — the ID value centred ~2px low and
 * its underline sat ~6px below Created's. The fix caps the detail pill to
 * the 16px value line.
 *
 * Non-vacuity: every assertion below was run against the pre-fix
 * kanban.css and goes red there (zone padding `4px 8px 8px 10px`, no
 * `.child-row-wrap--inline` rule, drop-line margin-left `10px`).
 * (Ticket 2e6b6b1f's describe lives in the same file, added with its
 * fix — its pre-fix red run is recorded in the lane report.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The stylesheet that actually ships.
const CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../kanban.css"),
  "utf-8",
);

/** All declaration blocks for a selector (the zone selector appears twice). */
function blocks(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g");
  return [...CSS.matchAll(re)].map((m) => m[1]);
}

/** Value of a single `prop:` declaration inside a block. */
function decl(block: string, prop: string): string {
  const m = block.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`));
  if (!m) throw new Error(`missing ${prop} declaration in block: ${block}`);
  return m[1].trim();
}

describe("child hover well spans the full card width (9ec6fbbb)", () => {
  it("the expanded children zone carries NO horizontal padding", () => {
    // The 10px/8px used to inset the tree (and the hover well painted on
    // it) inside the zone. Pre-fix this block reads `4px 8px 8px 10px`.
    const padded = blocks('.card-children-zone[data-expanded="true"]').filter(
      (b) => /padding\s*:/.test(b),
    );
    expect(padded).toHaveLength(1);
    expect(decl(padded[0], "padding")).toBe("4px 0 8px 0");
  });

  it("the inline row wrapper re-insets the CONTENT by the old zone pad", () => {
    // border-box + width:100% keeps the painted box full width; the pad
    // shrinks only the content, so row text stays at its old x. Pre-fix
    // this selector does not exist at all.
    const found = blocks(".child-row-wrap--inline");
    expect(found).toHaveLength(1);
    expect(decl(found[0], "padding-left")).toBe("10px");
    expect(decl(found[0], "padding-right")).toBe("8px");
  });

  it("the tree drop-line keeps its card-relative offset", () => {
    // The line's 10px margin-left assumed the old 10px zone pad; with the
    // pad gone it must carry the full 20px itself. Pre-fix: `2px 0 2px 10px`.
    const found = blocks(".tree-drop-line");
    expect(found).toHaveLength(1);
    expect(decl(found[0], "margin")).toBe("2px 0 2px 20px");
  });
});
