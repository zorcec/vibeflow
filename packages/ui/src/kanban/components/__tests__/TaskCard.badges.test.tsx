import React from "react";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TaskCard, computeHiddenFrom } from "../TaskCard";
import type { Task, Column } from "../../types";

// jsdom has no ResizeObserver — the cluster also listens to window resize,
// which is what these tests drive.
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

afterEach(() => {
  cleanup();
});

const col: Column = {
  id: "todo",
  label: "Todo",
  color: "#f59e0b",
  accent: "#f59e0b",
};

const TAGS = ["cli", "email", "mcp", "next", "private", "feature"];

function makeTask(): Task {
  return {
    id: "badge-task",
    title: "Badgy task",
    status: "todo",
    type: "Task",
    priority: "Medium",
    tags: TAGS,
  };
}

function renderCard() {
  const task = makeTask();
  return render(
    <TaskCard
      task={task}
      col={col}
      allTasks={[task]}
      onOpen={vi.fn()}
      onDragStart={vi.fn()}
    />,
  );
}

/** Drive the cluster's fit with scripted layout numbers. */
function mockLayout(widths: number[], available: number) {
  const cluster = document.querySelector(
    ".card-badge-cluster",
  ) as HTMLElement;
  expect(cluster).toBeTruthy();
  Object.defineProperty(cluster, "clientWidth", {
    value: available,
    configurable: true,
  });
  const measurer = cluster.querySelector(".card-badge-measure")!;
  const kids = Array.from(measurer.children) as HTMLElement[];
  // type + priority + 6 tags = 8 measured pills
  expect(kids).toHaveLength(2 + TAGS.length);
  kids.forEach((kid, i) => {
    Object.defineProperty(kid, "offsetWidth", {
      value: widths[i] ?? 40,
      configurable: true,
    });
  });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

describe("computeHiddenFrom (690858e0)", () => {
  it("shows everything when it fits exactly", () => {
    // 3 badges of 40px + 2 gaps of 3px = 126
    expect(computeHiddenFrom([40, 40, 40], 126, 3, 26)).toBe(3);
  });

  it("reserves the chip width once something hides", () => {
    // 126px of badges in 100px: keeping 2 (83px) + gap + chip (26) = 112 > 100,
    // keeping 1 (40) + gap + chip = 69 <= 100.
    expect(computeHiddenFrom([40, 40, 40], 100, 3, 26)).toBe(1);
  });

  it("hides everything when not even the chip plus one badge fits", () => {
    expect(computeHiddenFrom([40, 40], 20, 3, 26)).toBe(0);
  });

  it("handles the empty cluster", () => {
    expect(computeHiddenFrom([], 100, 3, 26)).toBe(0);
  });
});

describe("BadgeCluster overflow (690858e0)", () => {
  it("stays a single line with no overflow chip when everything fits", () => {
    renderCard();
    mockLayout(
      [44, 52, 30, 34, 28, 30, 40, 42],
      500,
    );
    expect(
      screen.queryByRole("button", { name: /more badge/ }),
    ).toBeNull();
    const cluster = document.querySelector(".card-badge-cluster")!;
    expect(cluster).toBeTruthy();
    // All six tag pills stay in the visible row (plus two in the hidden
    // measurer and none in a tooltip).
    expect(screen.getAllByTestId("tag-pill")).toHaveLength(
      TAGS.length * 2,
    );
    expect(
      cluster.querySelectorAll(":scope > [data-testid='tag-pill']"),
    ).toHaveLength(TAGS.length);
  });

  it("collapses behind '...' with an accessible name once badges overflow", () => {
    renderCard();
    // type(44) + priority(52) + 6 tags ≈ 300px in a 150px row.
    mockLayout([44, 52, 30, 34, 28, 30, 40, 42], 150);
    const chip = screen.getByRole("button", { name: /more badge/ });
    expect(chip).toHaveTextContent("…");
    expect(chip).toHaveAttribute(
      "aria-label",
      expect.stringContaining("mcp"),
    );
    // Hidden pills leave the visible row but stay in the measurer so a
    // later widening can bring them back.
    const cluster = document.querySelector(".card-badge-cluster")!;
    const visibleTags = Array.from(
      cluster.querySelectorAll(":scope > [data-testid='tag-pill']"),
    );
    expect(visibleTags.length).toBeLessThan(TAGS.length);
  });

  it("restores badges when the row widens again", () => {
    renderCard();
    mockLayout([44, 52, 30, 34, 28, 30, 40, 42], 150);
    expect(
      screen.queryByRole("button", { name: /more badge/ }),
    ).not.toBeNull();
    mockLayout([44, 52, 30, 34, 28, 30, 40, 42], 500);
    expect(
      screen.queryByRole("button", { name: /more badge/ }),
    ).toBeNull();
  });

  it("stacks the hidden badges one after another in the tooltip", () => {
    renderCard();
    mockLayout([44, 52, 30, 34, 28, 30, 40, 42], 150);
    const chip = screen.getByRole("button", { name: /more badge/ });
    fireEvent.mouseEnter(
      document.querySelector(".card-badge-wrap")!,
    );
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(tip).toBeTruthy();
    const rows = tip.querySelectorAll(".card-badge-tip-row");
    expect(rows.length).toBeGreaterThan(0);
    // Every hidden badge appears exactly once in the tooltip.
    const aria = chip.getAttribute("aria-label") ?? "";
    for (const row of Array.from(rows)) {
      expect(aria).toContain(row.textContent ?? "");
    }
    fireEvent.mouseLeave(document.querySelector(".card-badge-wrap")!);
  });

  it("opens the tooltip on keyboard focus", () => {
    renderCard();
    mockLayout([44, 52, 30, 34, 28, 30, 40, 42], 150);
    const chip = screen.getByRole("button", { name: /more badge/ });
    fireEvent.focus(chip);
    expect(
      screen.queryByRole("tooltip", { hidden: true }),
    ).not.toBeNull();
    fireEvent.blur(chip);
  });
});
