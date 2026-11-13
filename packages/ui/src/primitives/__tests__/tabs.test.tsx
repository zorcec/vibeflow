import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { Tabs } from "../tabs";

afterEach(cleanup);

const TABS = [
  { id: "details", label: "Details", panel: <p>Details panel</p> },
  { id: "activity", label: "Activity", panel: <p>Activity panel</p> },
  { id: "files", label: "Files", panel: <p>Files panel</p> },
] as const;

function renderTabs(props: Partial<Parameters<typeof Tabs>[0]> = {}) {
  const onValueChange = vi.fn();
  const utils = render(
    <Tabs value="details" onValueChange={onValueChange} tabs={TABS} aria-label="Sections" {...props} />,
  );
  return { ...utils, onValueChange };
}

describe("Tabs (P12)", () => {
  it("exposes tablist/tab/tabpanel roles", () => {
    renderTabs();
    expect(screen.getByRole("tablist")).toHaveAccessibleName("Sections");
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
  });

  it("marks only the active tab as selected", () => {
    renderTabs();
    const [details, activity] = screen.getAllByRole("tab");
    expect(details).toHaveAttribute("aria-selected", "true");
    expect(activity).toHaveAttribute("aria-selected", "false");
  });

  it("uses roving tabindex: only the active tab is tabbable", () => {
    renderTabs();
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
    expect(tabs[2]).toHaveAttribute("tabindex", "-1");
  });

  it("renders only the active panel's content", () => {
    renderTabs();
    expect(screen.getByText("Details panel")).toBeInTheDocument();
    expect(screen.queryByText("Activity panel")).toBeNull();
  });

  it("switches on click, exactly once per change", async () => {
    const { onValueChange } = renderTabs();
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("activity");
  });

  it("ArrowRight activates the next tab in automatic mode", () => {
    const { onValueChange } = renderTabs();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(onValueChange).toHaveBeenCalledWith("activity");
  });

  it("ArrowLeft wraps to the last tab, Home/End jump to the edges", () => {
    const { onValueChange } = renderTabs();
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(onValueChange).toHaveBeenLastCalledWith("files");
    fireEvent.keyDown(list, { key: "End" });
    expect(onValueChange).toHaveBeenLastCalledWith("files");
    fireEvent.keyDown(list, { key: "Home" });
    expect(onValueChange).toHaveBeenLastCalledWith("details");
  });

  it("skips disabled tabs when navigating", () => {
    const { onValueChange } = renderTabs({
      tabs: [
        { id: "details", label: "Details", panel: <p>Details panel</p> },
        { id: "locked", label: "Locked", panel: <p>Locked</p>, disabled: true },
        { id: "files", label: "Files", panel: <p>Files panel</p> },
      ],
    });
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(onValueChange).toHaveBeenCalledWith("files");
  });

  it("manual mode moves focus WITHOUT activating; Enter commits", () => {
    const { onValueChange } = renderTabs({ activationMode: "manual" });
    screen.getByRole("tab", { name: "Activity" }).focus();
    // Focus moved, but manual mode holds the candidate — no navigation.
    expect(onValueChange).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("tablist"), { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("activity");
  });

  it("manual mode commits on click", async () => {
    const { onValueChange } = renderTabs({ activationMode: "manual" });
    await userEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(onValueChange).toHaveBeenCalledWith("files");
  });

  it("keeps a disabled tab non-interactive", async () => {
    const { onValueChange } = renderTabs({
      tabs: [
        { id: "details", label: "Details", panel: <p>Details panel</p> },
        { id: "locked", label: "Locked", panel: <p>Locked</p>, disabled: true },
      ],
    });
    const locked = screen.getByRole("tab", { name: "Locked" });
    expect(locked).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(locked);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("supports a vertical orientation", () => {
    renderTabs({ orientation: "vertical" });
    expect(screen.getByRole("tablist")).toHaveAttribute(
      "aria-orientation",
      "vertical",
    );
  });

  it("uses token utilities only", () => {
    renderTabs();
    const tab = screen.getAllByRole("tab")[0];
    expect(tab.className).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(tab.className).not.toMatch(/\[[^\]]+\]/);
  });
});
describe("Tabs edge paths (P12)", () => {
  it("Home/End land on enabled tabs when the edges are disabled", () => {
    const onValueChange = vi.fn();
    render(
      <Tabs
        value="middle"
        onValueChange={onValueChange}
        aria-label="Sections"
        tabs={[
          { id: "first", label: "First", panel: <p>1</p>, disabled: true },
          { id: "middle", label: "Middle", panel: <p>2</p> },
          { id: "last", label: "Last", panel: <p>3</p>, disabled: true },
        ]}
      />,
    );
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "Home" });
    expect(onValueChange).toHaveBeenCalledWith("middle");
    fireEvent.keyDown(list, { key: "End" });
    expect(onValueChange).toHaveBeenLastCalledWith("middle");
  });

  it("Enter with no pending candidate does nothing", () => {
    const onValueChange = vi.fn();
    render(
      <Tabs
        value="details"
        onValueChange={onValueChange}
        activationMode="manual"
        aria-label="Sections"
        tabs={TABS}
      />,
    );
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "Enter" });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("arrow navigation keeps advancing focus past the first neighbour", () => {
    // Regression: origin was the committed `value`, so in manual mode every
    // ArrowRight recomputed the same neighbour and focus never moved on.
    const { onValueChange } = renderTabs({ activationMode: "manual" });
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Files" }));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("arrow navigation skips disabled tabs on every press", () => {
    const { onValueChange } = renderTabs({
      activationMode: "manual",
      value: "a",
      tabs: [
        { id: "a", label: "A", panel: <p>1</p> },
        { id: "b", label: "B", panel: <p>2</p>, disabled: true },
        { id: "c", label: "C", panel: <p>3</p> },
        { id: "d", label: "D", panel: <p>4</p> },
      ],
    });
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "C" }));
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "D" }));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("ignores arrow/Home/End keys when every tab is disabled", () => {
    // Regression: `% 0` yields NaN, `enabled[NaN]` is undefined and moveTo
    // dereferences `target.tab.id` — a TypeError instead of a no-op. jsdom
    // reports exceptions thrown in event listeners to `window` rather than
    // rethrowing through fireEvent, so listen for them explicitly.
    const onValueChange = vi.fn();
    render(
      <Tabs
        value="only"
        onValueChange={onValueChange}
        aria-label="Sections"
        tabs={[{ id: "only", label: "Only", panel: <p>1</p>, disabled: true }]}
      />,
    );
    const listenerErrors: unknown[] = [];
    const capture = (event: ErrorEvent) => listenerErrors.push(event.error ?? event.message);
    window.addEventListener("error", capture);
    try {
      const list = screen.getByRole("tablist");
      fireEvent.keyDown(list, { key: "ArrowRight" });
      fireEvent.keyDown(list, { key: "ArrowLeft" });
      fireEvent.keyDown(list, { key: "Home" });
      fireEvent.keyDown(list, { key: "End" });
    } finally {
      window.removeEventListener("error", capture);
    }
    expect(listenerErrors).toEqual([]);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("an unknown key is ignored", () => {
    const onValueChange = vi.fn();
    render(
      <Tabs value="details" onValueChange={onValueChange} aria-label="Sections" tabs={TABS} />,
    );
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "q" });
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
