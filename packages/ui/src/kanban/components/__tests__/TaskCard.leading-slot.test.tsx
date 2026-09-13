import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TaskCard } from "../TaskCard";
import {
      leadingSlotWidth,
      resolveLeadingSlotMarks,
} from "../TaskCardLeadingSlot";
import { displayedVerifyState, showsVerifyVerdict } from "../VerifyIndicator";
import type { Task, TaskStatus, Column } from "../../types";

/**
 * Regression tests for the leading slot of a card's title row.
 *
 * Both defects of the three-state verify indicator (`1c4374c`) came from one
 * root cause: the two TaskCard layouts built the slot inline and disagreed, so
 * a card could paint a verify glyph next to a loader *and* the unread dot, and
 * the slot's width varied with the marks — which slid the title between cards of
 * the same lane (up to 27px at the time). A test that only asked "is there an
 * icon?" passes on that broken code; these assert the arbitration (exactly one
 * mark) and the reserved width (identical title offset) instead.
 */

const GLYPH_MIN_SIZE = 11;

const lane = (id: TaskStatus): Column => ({
      id,
      label: id,
      color: "#f59e0b",
      accent: "#f59e0b",
});

function makeTask(overrides: Partial<Task> = {}): Task {
      return {
            id: "task-id",
            title: "Card title",
            status: "todo",
            ...overrides,
      };
}

function renderCard(
      task: Task,
      {
            col = lane("todo"),
            compact = false,
            currentUserId = "user-1",
      }: {
            col?: Column;
            compact?: boolean;
            currentUserId?: string;
      } = {},
) {
      return render(
            <TaskCard
                  task={task}
                  col={col}
                  compact={compact}
                  allTasks={[]}
                  currentUserId={currentUserId}
                  onOpen={vi.fn()}
                  onDragStart={vi.fn()}
            />,
      );
}

/** Every mark the leading slot rendered. */
function slotMarks(container: HTMLElement): string[] {
      return [...container.querySelectorAll("[data-leading-mark]")].map(
            (el) => el.getAttribute("data-leading-mark") ?? "",
      );
}

function slotWidth(container: HTMLElement): number {
      const slot = container.querySelector<HTMLElement>(
            '[data-role="leading-slot"]',
      );
      if (!slot) throw new Error("no leading slot rendered");
      return parseFloat(slot.style.width);
}

/**
 * What the title's x-offset is made of: the reserved widths of everything the
 * slot puts before the title. jsdom does no layout, so the reservation stands in
 * for a client rect — and it is the reservation that the fix makes constant.
 */
function titleOffsetReservation(container: HTMLElement): {
      reserved: number;
      preceding: number;
} {
      const row = titleRow(container);
      const title = container.querySelector<HTMLElement>(
            '[data-role="card-title"]',
      ) as HTMLElement;
      const preceding = [...row.children].slice(
            0,
            [...row.children].indexOf(title),
      ) as HTMLElement[];
      const reserved = preceding.reduce(
            (sum, el) => sum + (parseFloat(el.style.width || "0") || 0),
            0,
      );
      return { reserved, preceding: preceding.length };
}

/**
 * The title row, located WITHOUT the slot's test hooks so the same locator works
 * on the pre-fix markup: the row is the parent of the span carrying the title
 * typography (11.5px / 600), the one signature both layouts share.
 */
function titleRow(container: HTMLElement): HTMLElement {
      const title = [...container.querySelectorAll("span")].find(
            (s) =>
                  s.style.fontWeight === "600" && s.style.fontSize === "11.5px",
      );
      if (!title?.parentElement) throw new Error("no card title rendered");
      return title.parentElement;
}

/** Anything drawn as a status mark: glyph, loader, done check, dot. */
const MARK_SELECTOR =
      'svg, .spinner, [data-verify-state], [title="Unread"], [class^="sd-"]';

/**
 * How many status marks the title row actually paints, counted from the rendered
 * DOM rather than from the slot's own attributes — the count that used to reach
 * three on a single card.
 */
function paintedStatusMarks(container: HTMLElement): number {
      const row = titleRow(container);
      const title = [...row.children].find(
            (el) =>
                  (el as HTMLElement).style.fontWeight === "600" &&
                  (el as HTMLElement).style.fontSize === "11.5px",
      );
      let count = 0;
      for (const el of row.children) {
            if (el === title) continue;
            if (el.matches('[data-role="leading-slot"]')) {
                  count += el.querySelectorAll("[data-leading-mark]").length;
            } else if (el.matches(MARK_SELECTOR)) {
                  count += 1;
            }
      }
      return count;
}

/** The layout a lane renders in: the done lane and compact view use one row. */
function layoutFor(laneId: TaskStatus, compact: boolean): "card" | "row" {
      return compact || laneId === "done" ? "row" : "card";
}

/** Marks expected by reading the documented rules, not the implementation. */
function expectedMarks({
      laneId,
      verified,
      isUnread,
      compact,
}: {
      laneId: TaskStatus;
      verified: boolean | undefined;
      isUnread: boolean;
      compact: boolean;
}): string[] {
      if (showsVerifyVerdict(laneId) && verified !== undefined)
            return ["verify"];
      if (laneId === "in-progress") return ["activity"];
      if (laneId === "done") return ["done"];
      if (isUnread) return ["unread"];
      return layoutFor(laneId, compact) === "row" ? ["status"] : [];
}

const VERIFY_STATES: Array<{ label: string; verified: boolean | undefined }> = [
      { label: "verified", verified: true },
      { label: "failed", verified: false },
      { label: "none", verified: undefined },
];

const LANES: TaskStatus[] = [
      "backlog",
      "todo",
      "in-progress",
      "review",
      "done",
];

describe("leading slot mark arbitration", () => {
      it("gives the slot to the verdict over every other cue", () => {
            expect(
                  resolveLeadingSlotMarks({
                        verify: "verified",
                        layout: "card",
                        isInProgress: true,
                        isDone: false,
                        isUnread: true,
                  }),
            ).toEqual(["verify"]);
            expect(
                  resolveLeadingSlotMarks({
                        verify: "failed",
                        layout: "row",
                        isInProgress: false,
                        isDone: true,
                        isUnread: true,
                  }),
            ).toEqual(["verify"]);
      });

      it("falls back through activity, done, unread then the lane dot", () => {
            const read = {
                  verify: "none" as const,
                  layout: "card" as const,
                  isInProgress: false,
                  isDone: false,
                  isUnread: false,
            };
            expect(
                  resolveLeadingSlotMarks({
                        ...read,
                        isInProgress: true,
                        isDone: true,
                        isUnread: true,
                  }),
            ).toEqual(["activity"]);
            expect(
                  resolveLeadingSlotMarks({
                        ...read,
                        isDone: true,
                        isUnread: true,
                  }),
            ).toEqual(["done"]);
            expect(
                  resolveLeadingSlotMarks({ ...read, isUnread: true }),
            ).toEqual(["unread"]);
            expect(resolveLeadingSlotMarks(read)).toEqual([]);
            // The neutral lane dot belongs to the single-row layout alone.
            expect(resolveLeadingSlotMarks({ ...read, layout: "row" })).toEqual(
                  ["status"],
            );
      });

      it("never returns more than one mark, whatever the combination", () => {
            for (const layout of ["card", "row"] as const) {
                  for (const verify of [
                        "verified",
                        "failed",
                        "none",
                  ] as const) {
                        for (const isInProgress of [true, false]) {
                              for (const isDone of [true, false]) {
                                    for (const isUnread of [true, false]) {
                                          expect(
                                                resolveLeadingSlotMarks({
                                                      verify,
                                                      layout,
                                                      isInProgress,
                                                      isDone,
                                                      isUnread,
                                                }),
                                          ).toHaveLength(
                                                verify === "none" &&
                                                      !isInProgress &&
                                                      !isDone &&
                                                      !isUnread &&
                                                      layout === "card"
                                                      ? 0
                                                      : 1,
                                          );
                                    }
                              }
                        }
                  }
            }
      });

      it("reserves the widest mark of the layout", () => {
            expect(leadingSlotWidth("card")).toBeGreaterThanOrEqual(
                  GLYPH_MIN_SIZE,
            );
            expect(leadingSlotWidth("row")).toBeGreaterThanOrEqual(
                  GLYPH_MIN_SIZE,
            );
      });

      it("shows a verdict in the review and done lanes only", () => {
            expect(
                  LANES.filter((laneId) => showsVerifyVerdict(laneId)),
            ).toEqual(["review", "done"]);
            for (const laneId of LANES) {
                  expect(
                        displayedVerifyState({
                              status: laneId,
                              verified: true,
                        }),
                  ).toBe(showsVerifyVerdict(laneId) ? "verified" : "none");
            }
      });
});

describe("leading slot rendering", () => {
      for (const compact of [false, true]) {
            for (const laneId of LANES) {
                  const layout = layoutFor(laneId, compact);
                  const expectedWidth = leadingSlotWidth(layout);

                  for (const { label, verified } of VERIFY_STATES) {
                        it(`${layout} lane=${laneId} verify=${label} (compact=${compact}) draws one mark in a fixed-width slot`, () => {
                              for (const openedBy of [[], ["user-1"]]) {
                                    const { container, unmount } = renderCard(
                                          makeTask({
                                                status: laneId,
                                                verified,
                                                openedBy,
                                          }),
                                          { col: lane(laneId), compact },
                                    );
                                    const marks = slotMarks(container);
                                    const expected = expectedMarks({
                                          laneId,
                                          verified,
                                          isUnread: openedBy.length === 0,
                                          compact,
                                    });

                                    // (a) never more than one mark — the dedup
                                    // guard the multi-row branch used to lack.
                                    // Asserted on the paints themselves (not on
                                    // the slot's attributes) so it also holds
                                    // on the pre-fix markup.
                                    expect(paintedStatusMarks(container)).toBe(
                                          expected.length,
                                    );
                                    expect(marks.length).toBeLessThanOrEqual(1);
                                    expect(marks).toEqual(expected);

                                    // (b) the slot reserves its width regardless
                                    // of the mark, so the title cannot move.
                                    expect(slotWidth(container)).toBe(
                                          expectedWidth,
                                    );
                                    expect(
                                          slotWidth(container),
                                    ).toBeGreaterThanOrEqual(
                                          marks.length * GLYPH_MIN_SIZE,
                                    );
                                    expect(
                                          titleOffsetReservation(container),
                                    ).toEqual({
                                          reserved: expectedWidth,
                                          preceding: 1,
                                    });
                                    unmount();
                              }
                        });
                  }
            }
      }

      it("keeps the reserved width and title offset constant for every card of a lane", () => {
            // The bug-2 acceptance criterion: within review and done, the title's
            // x-offset must not depend on the marks. Both lanes are swept over
            // all verify states, read and unread.
            for (const laneId of ["review", "done"] as const) {
                  const widths = new Set<number>();
                  const reservations = new Set<number>();
                  const marks = new Set<string>();
                  for (const { verified } of VERIFY_STATES) {
                        for (const openedBy of [[], ["user-1"]]) {
                              const { container, unmount } = renderCard(
                                    makeTask({
                                          status: laneId,
                                          verified,
                                          openedBy,
                                    }),
                                    { col: lane(laneId) },
                              );
                              widths.add(slotWidth(container));
                              reservations.add(
                                    titleOffsetReservation(container).reserved,
                              );
                              slotMarks(container).forEach((m) => marks.add(m));
                              unmount();
                        }
                  }
                  // The lane really does render more than one kind of mark, so
                  // the constant width above is not vacuous.
                  expect(marks.size).toBeGreaterThan(1);
                  expect([...widths]).toEqual([
                        leadingSlotWidth(layoutFor(laneId, false)),
                  ]);
                  expect([...reservations]).toEqual([...widths]);
            }
      });

      it("shows exactly one glyph on a done + verified card (no second check)", () => {
            const { container } = renderCard(
                  makeTask({ status: "done", verified: true }),
                  { col: lane("done") },
            );
            expect(slotMarks(container)).toEqual(["verify"]);
            expect(
                  container.querySelectorAll('[data-verify-state="verified"]'),
            ).toHaveLength(1);
            // The muted done affordance must not also paint.
            expect(
                  container.querySelector('[data-leading-mark="done"]'),
            ).toBeNull();
            expect(container.querySelector(".spinner")).toBeNull();
      });

      it("keeps the muted done check on a done card that was never verified", () => {
            const { container } = renderCard(makeTask({ status: "done" }), {
                  col: lane("done"),
            });
            expect(slotMarks(container)).toEqual(["done"]);
            expect(
                  container.querySelector("[data-verify-state]"),
            ).not.toBeInTheDocument();
      });

      it("never lets a second mark stack with the verdict", () => {
            for (const verified of [true, false]) {
                  for (const status of ["review", "done"] as const) {
                        const { container, unmount } = renderCard(
                              makeTask({ status, verified, openedBy: [] }),
                              { col: lane(status) },
                        );
                        expect(slotMarks(container)).toEqual(["verify"]);
                        expect(
                              container.querySelector('[title="Unread"]'),
                        ).toBeNull();
                        expect(
                              container.querySelector(
                                    '[data-leading-mark="done"]',
                              ),
                        ).toBeNull();
                        unmount();
                  }
            }
      });

      it("keeps the verdict out of the backlog, todo and in-progress lanes", () => {
            for (const laneId of ["backlog", "todo", "in-progress"] as const) {
                  const { container } = renderCard(
                        makeTask({ status: laneId, verified: true }),
                        { col: lane(laneId) },
                  );
                  expect(
                        container.querySelector("[data-verify-state]"),
                  ).not.toBeInTheDocument();
                  expect(slotMarks(container)).not.toContain("verify");
            }
            // …while an in-progress card keeps its loader.
            const inProgress = renderCard(
                  makeTask({ status: "in-progress", verified: true }),
                  { col: lane("in-progress") },
            );
            expect(slotMarks(inProgress.container)).toEqual(["activity"]);
            expect(
                  inProgress.container.querySelector(".spinner"),
            ).toBeInTheDocument();
      });

      it("names the verdicts: implemented correctly vs not implemented correctly", () => {
            const verified = renderCard(
                  makeTask({ status: "review", verified: true }),
                  { col: lane("review") },
            );
            const failed = renderCard(
                  makeTask({ status: "review", verified: false }),
                  { col: lane("review") },
            );
            expect(
                  verified.container.querySelector("[data-verify-state]"),
            ).toHaveAttribute("aria-label", "Verified — implemented correctly");
            expect(
                  failed.container.querySelector(
                        '[data-verify-state="failed"]',
                  ),
            ).toHaveAttribute(
                  "aria-label",
                  "Failed verification — not implemented correctly",
            );
      });

      it("agrees on the verdict glyph across both layouts", () => {
            for (const verified of [true, false]) {
                  const cardLayout = renderCard(
                        makeTask({ status: "review", verified }),
                        { col: lane("review") },
                  );
                  const rowLayout = renderCard(
                        makeTask({ status: "review", verified }),
                        { col: lane("review"), compact: true },
                  );
                  expect(slotMarks(cardLayout.container)).toEqual(["verify"]);
                  expect(slotMarks(rowLayout.container)).toEqual(["verify"]);
                  expect(
                        rowLayout.container
                              .querySelector("[data-verify-state]")
                              ?.getAttribute("data-verify-state"),
                  ).toBe(
                        cardLayout.container
                              .querySelector("[data-verify-state]")
                              ?.getAttribute("data-verify-state"),
                  );
                  cardLayout.unmount();
                  rowLayout.unmount();
            }
      });

      it("renders no mark at all for an opened card with no verdict", () => {
            const { container } = renderCard(
                  makeTask({ status: "review", openedBy: ["user-1"] }),
                  { col: lane("review") },
            );
            expect(slotMarks(container)).toEqual([]);
            // …and the reserved slot is still there, so the title does not move.
            expect(slotWidth(container)).toBe(leadingSlotWidth("card"));
            expect(titleOffsetReservation(container)).toEqual({
                  reserved: leadingSlotWidth("card"),
                  preceding: 1,
            });
      });

      it("shows the unread dot alone when there is no verdict", () => {
            const { container } = renderCard(
                  makeTask({ status: "review", openedBy: [] }),
                  { col: lane("review") },
            );
            expect(slotMarks(container)).toEqual(["unread"]);
            expect(
                  container.querySelector('[title="Unread"]'),
            ).toBeInTheDocument();
      });
});
