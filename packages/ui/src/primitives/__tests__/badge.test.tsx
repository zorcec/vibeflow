import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { Badge, BADGE_TONES } from "../badge";

afterEach(cleanup);

const VARIANTS = ["default", "secondary", "outline", "danger"] as const;
const SIZES = ["sm", "md"] as const;

describe("Badge (P10.1)", () => {
  it("renders its label as the accessible name", () => {
    render(<Badge>In Progress</Badge>);
    expect(screen.getByText("In Progress")).toBeInTheDocument();
  });

  it("forwards data-* and aria-* to the DOM node", () => {
    render(
      <Badge data-testid="probe" aria-label="Status: done">
        Done
      </Badge>,
    );
    const el = screen.getByTestId("probe");
    expect(el).toHaveAttribute("aria-label", "Status: done");
  });

  it.each(VARIANTS)("variant %s applies a token-driven surface", (variant) => {
    render(<Badge variant={variant}>{variant}</Badge>);
    const el = screen.getByText(variant);
    const cls = el.className;
    // No raw colour, ever.
    expect(cls).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    // Each variant names a token utility, not an arbitrary value.
    expect(cls).toMatch(/\bbg-(accent|bg-raised|hover|transparent|danger-soft)\b|\bbg-\[/);
    expect(cls).not.toMatch(/\[[^\]]+\]/);
  });

  it.each(SIZES)("size %s is a defined step and never an arbitrary value", (size) => {
    render(<Badge size={size}>{size}</Badge>);
    const cls = screen.getByText(size).className;
    expect(cls).toMatch(size === "sm" ? /\btext-xs\b/ : /\btext-sm\b/);
    expect(cls).not.toMatch(/\[[^\]]+\]/);
  });

  it("renders the dot as decorative, so the label carries the meaning", () => {
    render(<Badge dot>Todo</Badge>);
    const dot = document.querySelector('[data-role="badge-dot"]');
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Todo")).toBeInTheDocument();
  });

  it("applies every declared tone (the set is exported, not hand-copied)", () => {
    for (const tone of BADGE_TONES) {
      const { unmount } = render(<Badge tone={tone}>{tone}</Badge>);
      const cls = screen.getByText(tone).className;
      expect(cls, `tone ${tone} must resolve a chip/status token`).toMatch(
        /\btext-(chip|text)-[a-z0-9-]+\b/,
      );
      expect(cls, `tone ${tone} must not use a raw colour`).not.toMatch(
        /#[0-9a-f]{3,8}|rgba?\(/i,
      );
      unmount();
    }
  });

  /**
   * PARITY WITH THE SHIPPED BADGES (ticket requirement).
   *
   * The canonical status hues are pinned by
   * `kanban/components/__tests__/StatusBadgeColors.test.ts`. Its expectations are
   * parsed from that file rather than copied here, so if the canonical map
   * rotates, this test fails until Badge follows — a copy would silently drift
   * and let the migration in P16 repaint working components.
   */
  it("reproduces the canonical status hues from StatusBadgeColors' own expectations", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const canonical = readFileSync(
      resolve(here, "../../kanban/components/__tests__/StatusBadgeColors.test.ts"),
      "utf-8",
    );
    const expected: Record<string, string> = {};
    for (const m of canonical.matchAll(
      /"?([a-z-]+)"?:\s*"var\((--t-chip-[a-z0-9-]+)\)"/g,
    )) {
      expected[m[1]] = m[2];
    }

    // The canonical map must still name the five statuses; an empty parse would
    // make this test vacuous, so it fails loudly instead.
    expect(Object.keys(expected).sort()).toEqual([
      "backlog",
      "done",
      "in-progress",
      "review",
      "todo",
    ]);

    const toneFor: Record<string, string> = {
      backlog: "status-backlog",
      todo: "status-todo",
      "in-progress": "status-progress",
      review: "status-review",
      done: "status-done",
    };

    for (const [status, token] of Object.entries(expected)) {
      const utility = token.replace("--t-", "");
      const tone = toneFor[status];
      const { unmount } = render(<Badge tone={tone as never}>{status}</Badge>);
      const cls = screen.getByText(status).className;
      expect(cls, `${tone} must wear ${utility} (${token})`).toContain(
        `text-${utility}`,
      );
      unmount();
    }
  });
});
