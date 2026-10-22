// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FilterBar, type FilterState } from "../FilterBar";
import type { Task } from "../../types";

afterEach(cleanup);

/**
 * Ticket db2fce26 — per-tag "Remove" action in the tags filter (UI half).
 *
 * Each tag gets a Remove action reachable by hover AND keyboard focus (not
 * hover-only). It asks for confirmation naming the tag and the count, cancel
 * does nothing, and confirm calls `onRemoveTagFromAll` exactly once. Without
 * the prop no Remove action renders at all.
 */
const tasks: Task[] = [
  { id: "t1", title: "One", status: "todo", tags: ["frontend", "urgent"] },
  { id: "t2", title: "Two", status: "todo", tags: ["frontend"] },
  { id: "t3", title: "Three", status: "done", tags: ["backend"] },
];

const baseFilter: FilterState = {
  status: "all",
  component: null,
  type: null,
  user: null,
  tags: [],
};

function renderBar(props?: {
  onRemoveTagFromAll?: (tag: string) => Promise<number>;
  countTasksWithTag?: (tag: string) => number;
}) {
  return render(
    <FilterBar
      tasks={tasks}
      filter={baseFilter}
      onFilter={vi.fn()}
      {...props}
    />,
  );
}

function openTags() {
  fireEvent.click(screen.getByRole("button", { name: /tags/i }));
}

function removeButton(tag: string) {
  return screen.getByRole("button", {
    name: `Remove ${tag} from all tasks`,
  });
}

describe("FilterBar per-tag Remove (db2fce26)", () => {
  it("renders no Remove action at all without onRemoveTagFromAll", () => {
    renderBar();
    openTags();
    expect(
      screen.queryByRole("button", { name: /remove .* from all tasks/i }),
    ).toBeNull();
  });

  it("reveals the action on hover", () => {
    renderBar({ onRemoveTagFromAll: vi.fn(async () => 0) });
    openTags();
    const btn = removeButton("frontend");
    expect(btn).toHaveStyle({ opacity: "0" });
    const row = document.querySelector('[data-tag-row="frontend"]')!;
    fireEvent.mouseEnter(row);
    expect(btn).toHaveStyle({ opacity: "1" });
    fireEvent.mouseLeave(row);
    expect(btn).toHaveStyle({ opacity: "0" });
  });

  it("reveals the action on keyboard focus (not hover-only)", () => {
    renderBar({ onRemoveTagFromAll: vi.fn(async () => 0) });
    openTags();
    const btn = removeButton("backend");
    expect(btn).toHaveStyle({ opacity: "0" });
    fireEvent.focus(btn);
    expect(btn).toHaveStyle({ opacity: "1" });
    fireEvent.blur(btn);
    expect(btn).toHaveStyle({ opacity: "0" });
  });

  it("confirmation names the tag and the count; cancel does nothing", async () => {
    const onRemove = vi.fn(async (_tag: string) => 2);
    renderBar({ onRemoveTagFromAll: onRemove });
    openTags();
    fireEvent.click(removeButton("frontend"));
    expect(
      screen.getByText('Remove "frontend" from 2 tasks? This cannot be undone.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/This cannot be undone/),
      ).toBeNull(),
    );
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("confirm calls the callback once with the tag", async () => {
    const onRemove = vi.fn(async (_tag: string) => 1);
    renderBar({ onRemoveTagFromAll: onRemove });
    openTags();
    fireEvent.click(removeButton("backend"));
    expect(
      screen.getByText('Remove "backend" from 1 task? This cannot be undone.'),
    ).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Remove" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(
        screen.queryByText(/This cannot be undone/),
      ).toBeNull(),
    );
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("backend");
  });

  it("honours an explicit countTasksWithTag override", () => {
    renderBar({
      onRemoveTagFromAll: vi.fn(async () => 0),
      countTasksWithTag: () => 42,
    });
    openTags();
    fireEvent.click(removeButton("frontend"));
    expect(
      screen.getByText('Remove "frontend" from 42 tasks? This cannot be undone.'),
    ).toBeInTheDocument();
  });

  it("Enter with Cancel focused does NOT confirm; Enter on the confirm button does", async () => {
    const onRemove = vi.fn(async (_tag: string) => 1);
    renderBar({ onRemoveTagFromAll: onRemove });
    openTags();
    fireEvent.click(removeButton("frontend"));
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
    // Focus Cancel and press Enter — the old window-global handler called
    // onConfirm for ANY Enter, turning Cancel into Delete.
    screen.getByRole("button", { name: "Cancel" }).focus();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
    // Same key with the confirm button focused really confirms — once.
    screen.getByRole("button", { name: "Remove" }).focus();
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() =>
      expect(screen.queryByText(/This cannot be undone/)).toBeNull(),
    );
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("Escape while removal is pending is ignored — no second in-flight call", async () => {
    let resolveRemoval!: (n: number) => void;
    const onRemove = vi.fn(
      (_tag: string) =>
        new Promise<number>((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    renderBar({ onRemoveTagFromAll: onRemove });
    openTags();
    fireEvent.click(removeButton("frontend"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    // While the first call is still in flight, Escape must NOT close the
    // dialog: closing would clear the pending flag and let a reopened
    // confirm fire a second call alongside the first.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
    // Nor may a second confirm fire while the first is pending (the button
    // shows its spinner as "Deleting…" mid-flight, so query it by id).
    fireEvent.click(document.querySelector("#confirm-modal-confirm")!);
    expect(onRemove).toHaveBeenCalledTimes(1);
    resolveRemoval(2);
    await waitFor(() =>
      expect(screen.queryByText(/This cannot be undone/)).toBeNull(),
    );
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("Escape aborts the confirmation and focus returns to the tag", async () => {
    const onRemove = vi.fn(async () => 0);
    renderBar({ onRemoveTagFromAll: onRemove });
    openTags();
    const btn = removeButton("frontend");
    fireEvent.click(btn);
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByText(/This cannot be undone/)).toBeNull(),
    );
    expect(onRemove).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(btn);
  });
});
