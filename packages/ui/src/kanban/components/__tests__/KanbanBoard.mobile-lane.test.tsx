import React from "react";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Header } from "../Header";
import { KanbanBoard } from "../KanbanBoard";
import type { Task, TaskStatus } from "../../types";

/**
 * MOBILE-KANBAN M1 (ticket k2x2agpos66jpsggi1owj1er) — the phone contract:
 *
 *  1. at <=767px the main area mounts EXACTLY ONE lane (the active one),
 *     all of its cards rendered up front — no virtualization;
 *  2. the lane pills live IN the sticky header (Header owns the
 *     `#kb-lane-pills` slot, KanbanBoard portals into it) and are the
 *     primary toggle — tapping one swaps which lane is mounted;
 *  3. at >=768px nothing changes: every visible lane mounts and the header
 *     slot stays empty (kanban.css hides it at every width by default).
 *
 * jsdom has no `matchMedia`, so the desktop test needs no mock; the phone
 * test installs the same `Object.defineProperty(window, "matchMedia", …)`
 * shape the other suites use. `Header` MUST render before the board in the
 * tree — both consuming surfaces do, and the portal target has to exist by
 * the time the board's effect looks for it.
 */

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

afterAll(() => {
  // jsdom ships no matchMedia; remove the mock so nothing leaks (each file
  // gets its own environment, this is belt-and-braces).
  Reflect.deleteProperty(window, "matchMedia");
});

/** Install a `(max-width: 767px)` matcher: `true` = phone, `false` = desktop. */
function setPhoneViewport(isPhone: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("max-width") ? isPhone : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }),
  });
}

function makeTask(id: string, status: TaskStatus): Task {
  return { id, title: `Task ${id}`, status };
}

const TASKS: Task[] = [
  makeTask("b1", "backlog"),
  makeTask("b2", "backlog"),
  makeTask("t1", "todo"),
  makeTask("r1", "review"),
  makeTask("r2", "review"),
  makeTask("r3", "review"),
  makeTask("d1", "done"),
];

function renderSurface() {
  return render(
    <>
      <Header
        projectName="Mobile lane board"
        searchQuery=""
        taskSummary="7 open"
        onSearchChange={vi.fn()}
        onSettings={vi.fn()}
      />
      <KanbanBoard
        tasks={TASKS}
        visibleCols={["backlog", "todo", "in-progress", "review", "done"]}
        searchQuery=""
        onOpenPanel={vi.fn()}
        onDrop={vi.fn()}
      />
    </>,
  );
}

function lanePills(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll("#kb-lane-pills .kb-lane-pill");
}

function mountedLanes(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".board-column")).map(
    (el) => el.getAttribute("data-column-id") ?? "?",
  );
}

describe("phone (<=767px): one lane at a time, pills in the header", () => {
  it("mounts only the active lane — every other lane is absent from the DOM", async () => {
    setPhoneViewport(true);
    const { container } = renderSurface();
    await waitFor(() => expect(lanePills(container)).toHaveLength(5));

    // Default active lane = first visible column; the rest never render.
    expect(mountedLanes(container)).toEqual(["backlog"]);
    for (const absent of ["todo", "in-progress", "review", "done"]) {
      expect(
        container.querySelector(`[data-column-id="${absent}"]`),
        `lane ${absent} must not be mounted on a phone`,
      ).toBeNull();
    }
  });

  it("renders the lane pills INSIDE the sticky header, with counts and pressed state", async () => {
    setPhoneViewport(true);
    const { container } = renderSurface();
    await waitFor(() => expect(lanePills(container)).toHaveLength(5));

    const header = container.querySelector("header.kb-header");
    expect(header, "the shared Header element must be present").not.toBeNull();
    const slot = header!.querySelector("#kb-lane-pills");
    expect(slot, "pills must live in the header slot, not in the board").not.toBeNull();

    const pills = lanePills(container);
    // Labels come from the board's COLUMNS, in board order.
    expect(Array.from(pills).map((p) => p.getAttribute("data-status"))).toEqual([
      "backlog",
      "todo",
      "in-progress",
      "review",
      "done",
    ]);
    // Counts mirror the column headers (root cards per lane).
    expect(
      pills[0].querySelector(".kb-lane-pill-count")?.textContent,
    ).toBe("2");
    expect(
      pills[3].querySelector(".kb-lane-pill-count")?.textContent,
    ).toBe("3");
    // Exactly one pill reads as pressed: the mounted lane.
    expect(pills[0].getAttribute("aria-pressed")).toBe("true");
    expect(pills[3].getAttribute("aria-pressed")).toBe("false");
  });

  it("tapping a pill swaps which single lane is mounted", async () => {
    setPhoneViewport(true);
    const { container } = renderSurface();
    await waitFor(() => expect(lanePills(container)).toHaveLength(5));

    const reviewPill = container.querySelector<HTMLButtonElement>(
      '#kb-lane-pills .kb-lane-pill[data-status="review"]',
    )!;
    fireEvent.click(reviewPill);

    await waitFor(() => expect(mountedLanes(container)).toEqual(["review"]));
    // The cards of the new lane are all there up front (no lazy loading).
    expect(
      container.querySelectorAll('[data-column-id="review"] [data-role="task-card"]'),
    ).toHaveLength(3);
    // Pressed state follows the mounted lane.
    expect(reviewPill.getAttribute("aria-pressed")).toBe("true");
    expect(
      container
        .querySelector('#kb-lane-pills .kb-lane-pill[data-status="backlog"]')!
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

describe("desktop (>=768px): unchanged strip", () => {
  it("mounts every visible lane and leaves the header slot empty", async () => {
    setPhoneViewport(false);
    const { container } = renderSurface();
    await waitFor(() =>
      expect(mountedLanes(container)).toEqual([
        "backlog",
        "todo",
        "in-progress",
        "review",
        "done",
      ]),
    );
    expect(lanePills(container)).toHaveLength(0);
  });

  it("stays on the desktop path when matchMedia is unavailable (SSR/jsdom)", async () => {
    Reflect.deleteProperty(window, "matchMedia");
    const { container } = renderSurface();
    await waitFor(() => expect(mountedLanes(container)).toHaveLength(5));
    expect(lanePills(container)).toHaveLength(0);
  });
});
