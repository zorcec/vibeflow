// @vitest-environment jsdom
/**
 * Needs-attention badge (ticket 0752d55c): verify-style amber pill fed by
 * the task's `needsAttention` field. The badge cluster shows it right after
 * the type badge when flagged and omits it otherwise; the pill itself
 * renders nothing unless flagged, so callers place it unconditionally.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AttentionBadge } from "../../../AttentionBadge";
import { BadgeCluster } from "../TaskCard";
import type { Column } from "../../types";

const col: Column = {
  id: "todo",
  label: "Todo",
  color: "#f59e0b",
  accent: "#f59e0b",
};

describe("AttentionBadge", () => {
  it("renders the pill with the flagged hook when flagged", () => {
    const { container } = render(<AttentionBadge flagged />);
    expect(container.textContent).toContain("Needs attention");
    expect(
      container.querySelector('[data-attention-state="flagged"]'),
    ).not.toBeNull();
  });

  it("renders nothing when not flagged", () => {
    const { container } = render(<AttentionBadge />);
    expect(container.textContent).toBe("");
    const { container: absent } = render(
      <AttentionBadge flagged={false} />,
    );
    expect(absent.textContent).toBe("");
  });
});

describe("BadgeCluster needs-attention", () => {
  it("shows the attention pill for a flagged task", () => {
    const { container } = render(
      <BadgeCluster type="Task" needsAttention={true} />,
    );
    expect(container.textContent).toContain("Needs attention");
    expect(
      container.querySelector('[data-attention-state="flagged"]'),
    ).not.toBeNull();
  });

  it("omits the attention pill when the flag is absent", () => {
    const { container } = render(<BadgeCluster type="Task" />);
    expect(container.textContent).not.toContain("Needs attention");
    expect(
      container.querySelector('[data-attention-state="flagged"]'),
    ).toBeNull();
  });

  it("omits the attention pill when explicitly cleared", () => {
    void col;
    const { container } = render(
      <BadgeCluster type="Task" needsAttention={false} />,
    );
    expect(
      container.querySelector('[data-attention-state="flagged"]'),
    ).toBeNull();
  });
});
