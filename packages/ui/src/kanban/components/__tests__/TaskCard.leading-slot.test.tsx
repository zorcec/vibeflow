import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TaskCard } from "../TaskCard";
import {
      laneReservesLeadingSlot,
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
            reserveLeadingSlot,
      }: {
            col?: Column;
            compact?: boolean;
            currentUserId?: string;
            reserveLeadingSlot?: boolean;
      } = {},
) {
      return render(
            <TaskCard
                  task={task}
                  col={col}
                  compact={compact}
                  allTasks={[]}
                  currentUserId={currentUserId}
                  reserveLeadingSlot={reserveLeadingSlot}
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
      const el = container.querySelector<HTMLElement>(
            '[data-role="leading-slot"]',
      );
      if (!el) throw new Error("no leading slot rendered");
      return parseFloat(el.style.width);
}

/**
 * Whether anything is rendered in the leading position at all — the mark box, or
 * (in older revisions) a spacer. A markless card must now render NOTHING here, so
 * this is the assertion that the phantom gutter is gone rather than merely quiet.
 */
function leadingSlotEl(container: HTMLElement): HTMLElement | null {
      return container.querySelector<HTMLElement>(
            '[data-role="leading-slot"], [data-role="leading-slot-spacer"]',
      );
}

/**
 * Whether the leading position holds a PADDED BOX (which can look like a mark)
 * rather than a bare spacer. The phantom gutter of 8545aeca was an empty box, so
 * this is what the fix is asserted against.
 */
function leadingSlotBox(container: HTMLElement): HTMLElement | null {
      return container.querySelector<HTMLElement>('[data-role="leading-slot"]');
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
      if (showsVerifyVerdict({ status: laneId }) && verified !== undefined)
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
                  LANES.filter((laneId) =>
                        showsVerifyVerdict({ status: laneId, type: "Task" }),
                  ),
            ).toEqual(["review", "done"]);
            for (const laneId of LANES) {
                  expect(
                        displayedVerifyState({
                              status: laneId,
                              verified: true,
                        }),
                  ).toBe(
                        showsVerifyVerdict({ status: laneId })
                              ? "verified"
                              : "none",
                  );
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

                                    // (b) the slot exists IFF a mark is drawn.
                                    // A markless card renders NOTHING in the
                                    // leading position — no box, no spacer — so
                                    // there is no phantom gutter (8545aeca).
                                    // Title alignment across a lane is a
                                    // deliberate casualty of that choice
                                    // (owner option B, Sep 2026).
                                    if (expected.length === 0) {
                                          expect(
                                                leadingSlotEl(container),
                                          ).toBeNull();
                                    } else {
                                          expect(slotWidth(container)).toBe(
                                                expectedWidth,
                                          );
                                          expect(
                                                slotWidth(container),
                                          ).toBeGreaterThanOrEqual(
                                                marks.length * GLYPH_MIN_SIZE,
                                          );
                                    }
                                    unmount();
                              }
                        });
                  }
            }
      }

      it("renders a slot only for cards that draw a mark, in every lane", () => {
            // The deliverable of the owner's option B: a markless card has NO
            // leading element at all. This is what removes the phantom gutter —
            // reserving the width with a spacer hid the fake badge but kept the
            // gap, which the owner rejected twice.
            //
            // NOTE: title x-offset is deliberately NOT constant across a lane any
            // more. Every card that draws nothing starts its title at the row's
            // left edge instead of after an empty gutter. That trade was made on
            // purpose; do not "restore" alignment without re-reading 8545aeca.
            for (const laneId of LANES) {
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
                              const drawn = slotMarks(container);
                              if (drawn.length === 0) {
                                    expect(
                                          leadingSlotEl(container),
                                    ).toBeNull();
                              } else {
                                    expect(slotWidth(container)).toBe(
                                          leadingSlotWidth(
                                                layoutFor(laneId, false),
                                          ),
                                    );
                              }
                              unmount();
                        }
                  }
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

      it("renders no mark and NO space for an opened card with no verdict", () => {
            const { container } = renderCard(
                  makeTask({ status: "review", openedBy: ["user-1"] }),
                  { col: lane("review") },
            );
            expect(slotMarks(container)).toEqual([]);
            // Nothing at all in the leading position: no box and no spacer. The
            // title starts at the row's left edge.
            expect(leadingSlotEl(container)).toBeNull();
      });

      it("draws nothing at all for a markless card, even in a lane that has marks (8545aeca)", () => {
            // The owner-reported phantom space, and the second attempt at it.
            // First revision painted an empty 11px box on every card; the second
            // reserved the width with an invisible spacer. Both left a visible
            // gap before the title. The owner rejected the gap, so a markless
            // card now renders NOTHING — no box, no spacer.
            const { container } = renderCard(
                  makeTask({ status: "review", openedBy: ["user-1"] }),
                  { col: lane("review"), reserveLeadingSlot: true },
            );
            expect(leadingSlotBox(container)).toBeNull();
            expect(
                  container.querySelector('[data-role="leading-slot-spacer"]'),
            ).toBeNull();
            expect(leadingSlotEl(container)).toBeNull();
            expect(slotMarks(container)).toEqual([]);
      });

      it("draws the mark box when a card has a verdict", () => {
            const { container } = renderCard(
                  makeTask({ status: "review", verified: true }),
                  { col: lane("review") },
            );
            expect(leadingSlotBox(container)).not.toBeNull();
            expect(slotWidth(container)).toBe(leadingSlotWidth("card"));
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

/**
 * The task TYPE gate (bb308ad4).
 *
 * The verdict gate used to read only the lane: `displayedVerifyState` returned
 * whatever verdict the store held for ANY task in review/done, so a Research task
 * — which can never be UI-verified, because `vibeflow verify` needs an annotation
 * baseline and the CLI forbids Research tasks from producing code — rendered the
 * amber "failed verification" glyph. These assert the type gate on top of the
 * lane gate, through `displayedVerifyState` (the one predicate the card and the
 * child row both read), and pin the default chosen for the types the owner did
 * not name.
 */
describe("verify verdict type gate (bb308ad4)", () => {
      it("never shows a verdict for a Research task, in review or done, whatever the stored value", () => {
            for (const status of ["review", "done"] as const) {
                  for (const verified of [true, false, undefined]) {
                        expect(
                              displayedVerifyState({
                                    status,
                                    type: "Research",
                                    verified,
                              }),
                        ).toBe("none");
                  }
            }
      });

      it("matches the type case-insensitively and ignores surrounding whitespace", () => {
            for (const type of ["research", "RESEARCH", " Research "]) {
                  expect(
                        displayedVerifyState({
                              status: "review",
                              type,
                              verified: true,
                        }),
                  ).toBe("none");
            }
      });

      it("still shows the verdict for Task and Bug in every state", () => {
            for (const type of ["Task", "Bug"] as const) {
                  for (const { label, verified } of [
                        { label: "verified", verified: true },
                        { label: "failed", verified: false },
                  ]) {
                        expect(
                              displayedVerifyState({
                                    status: "review",
                                    type,
                                    verified,
                              }),
                        ).toBe(label);
                  }
            }
      });

      it("shows the verdict for Enhancement, Feature, Chore and an absent type", () => {
            // The default chosen for the types the owner did not name. Every
            // non-{Task,Bug,Research} value resolves to the generic Task
            // (`TypeBadge`, `getTaskTypeIcon(type ?? "Task")`, and the CLI's
            // `normalizeTaskType`), and the owner's rule names Task — so they all
            // SHOW, including the 239 untyped tasks, which count as a Task.
            for (const type of [
                  "Enhancement",
                  "Feature",
                  "Chore",
                  null,
                  undefined,
                  "[object Object]",
            ]) {
                  expect(
                        displayedVerifyState({
                              status: "review",
                              type,
                              verified: true,
                        }),
                  ).toBe("verified");
            }
      });

      it("keeps the lane gate on top of the type gate", () => {
            for (const status of ["backlog", "todo", "in-progress"] as const) {
                  expect(
                        displayedVerifyState({
                              status,
                              type: "Task",
                              verified: true,
                        }),
                  ).toBe("none");
            }
      });

      it("renders no indicator for a Research task in review and in done", () => {
            for (const status of ["review", "done"] as const) {
                  for (const verified of [true, false]) {
                        const { container, unmount } = renderCard(
                              makeTask({ status, type: "Research", verified }),
                              { col: lane(status) },
                        );
                        expect(
                              container.querySelector("[data-verify-state]"),
                        ).not.toBeInTheDocument();
                        expect(slotMarks(container)).not.toContain("verify");
                        unmount();
                  }
            }
      });

      it("still renders the verdict for a Bug and a Task in review and in done", () => {
            for (const status of ["review", "done"] as const) {
                  for (const type of ["Task", "Bug"] as const) {
                        for (const verified of [true, false]) {
                              const { container, unmount } = renderCard(
                                    makeTask({ status, type, verified }),
                                    { col: lane(status) },
                              );
                              expect(slotMarks(container)).toEqual(["verify"]);
                              expect(
                                    container
                                          .querySelector("[data-verify-state]")
                                          ?.getAttribute("data-verify-state"),
                              ).toBe(verified ? "verified" : "failed");
                              unmount();
                        }
                  }
            }
      });
});

/**
 * Lane-scoped leading-slot reservation (8545aeca).
 *
 * `leadingSlotWidth` was reserved unconditionally, so a card that resolved no
 * mark still got an empty 11px (card) / 12px (row) gutter before its title —
 * visible on e.g. 52ea1bdd. The reservation exists only to keep the titles of
 * the SAME lane aligned (b0545910), so it is now decided once per lane by
 * `laneReservesLeadingSlot`: a lane that draws at least one mark reserves for
 * every card in it (titles stay aligned, the gutter is the alignment column); a
 * lane that draws no mark reserves nothing (no gutter).
 */
describe("lane-scoped leading slot reservation (8545aeca)", () => {
      const read = (overrides: Partial<Task> = {}) =>
            makeTask({ openedBy: ["user-1"], ...overrides });

      it("reserves when at least one card of the lane draws a mark", () => {
            expect(
                  laneReservesLeadingSlot(
                        [
                              read({
                                    id: "a",
                                    status: "review",
                                    verified: true,
                              }),
                              read({ id: "b", status: "review" }),
                        ],
                        {
                              laneId: "review",
                              compact: false,
                              currentUserId: "user-1",
                        },
                  ),
            ).toBe(true);
      });

      it("reserves nothing when no card of the lane draws a mark", () => {
            expect(
                  laneReservesLeadingSlot([read({ id: "a", status: "todo" })], {
                        laneId: "todo",
                        compact: false,
                        currentUserId: "user-1",
                  }),
            ).toBe(false);
      });

      it("reserves an in-progress lane — every card draws the spinner", () => {
            expect(
                  laneReservesLeadingSlot([read({ status: "in-progress" })], {
                        laneId: "in-progress",
                        compact: false,
                        currentUserId: "user-1",
                  }),
            ).toBe(true);
      });

      it("reserves a row-layout lane — the lane dot is its fallback mark", () => {
            expect(
                  laneReservesLeadingSlot([read({ status: "review" })], {
                        laneId: "review",
                        compact: true,
                        currentUserId: "user-1",
                  }),
            ).toBe(true);
      });

      it("counts an unread card as a mark", () => {
            expect(
                  laneReservesLeadingSlot(
                        [makeTask({ status: "todo", openedBy: [] })],
                        {
                              laneId: "todo",
                              compact: false,
                              currentUserId: "user-1",
                        },
                  ),
            ).toBe(true);
      });

      it("shares the verdict type gate: a Research verdict is not a mark", () => {
            expect(
                  laneReservesLeadingSlot(
                        [
                              read({
                                    status: "review",
                                    type: "Research",
                                    verified: true,
                              }),
                        ],
                        {
                              laneId: "review",
                              compact: false,
                              currentUserId: "user-1",
                        },
                  ),
            ).toBe(false);
      });

      it("renders no slot at all — and no gap — when the lane reserves nothing", () => {
            const { container } = renderCard(read({ status: "todo" }), {
                  col: lane("todo"),
                  reserveLeadingSlot: false,
            });
            expect(
                  container.querySelector('[data-role="leading-slot"]'),
            ).toBeNull();
            expect(
                  container.querySelector('[data-role="card-title"]'),
            ).not.toBeNull();
      });

      it("still draws a mark in the reserved width if one resolves", () => {
            const { container } = renderCard(
                  read({ status: "review", verified: true }),
                  { col: lane("review"), reserveLeadingSlot: false },
            );
            expect(slotMarks(container)).toEqual(["verify"]);
            expect(slotWidth(container)).toBe(leadingSlotWidth("card"));
      });

      it("draws nothing for a markless card whatever the caller knows about its lane", () => {
            // `reserve` used to control whether the width was held open for a
            // markless card. That reservation is gone (owner option B), so the
            // flag no longer changes what is rendered — a card with no mark has
            // no leading element on any caller.
            const { container } = renderCard(read({ status: "todo" }));
            expect(slotMarks(container)).toEqual([]);
            expect(leadingSlotEl(container)).toBeNull();
      });

      it("gives the row layout's lane-dot fallback a real box in kanban.css", () => {
            const css = readFileSync(
                  resolve(
                        dirname(fileURLToPath(import.meta.url)),
                        "../../kanban.css",
                  ),
                  "utf-8",
            );
            // `.sd-*` declared only a background, so the row fallback mark rendered
            // 0px wide and the 12px reservation hid a mark with no box.
            const rule = css.match(/\.sd-backlog,[\s\S]*?\}/);
            expect(rule?.[0]).toMatch(/width:\s*7px/);
            expect(rule?.[0]).toMatch(/height:\s*7px/);
      });
});
